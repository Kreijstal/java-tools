"use strict";

// The compile worker of docs/plan-linear-runtime.md Phase 1.2, as an actual
// thread. It boots its own JVM, receives compile requests over postMessage,
// and answers with the plain data of JitCompiler.serializeGeneratedResult.
//
// It never runs a guest instruction and never sees a live object of the main
// thread: classes arrive as their structured-cloned AST (postMessage does the
// cloning), and results leave as plain data that the requesting JIT rebuilds
// against its own tables. The in-process ShadowCompiler speaks the same
// protocol synchronously; this file is the same conversation over a port.

const { JVM } = require("../core/jvm");
const { StaticFieldStore } = require("../core/StaticFieldStore");
const JitCompiler = require("./JitCompiler");

// The same conversation over two different ports. `worker_threads` gives this
// file its configuration up front in `workerData`; a browser Worker has no
// such thing, so there the same payload arrives as the first message and the
// JVM cannot be built until it does. That is the only structural difference,
// and it is why the state below is assigned rather than constructed at load.
let parentPort = null;
let workerData = null;
try {
  ({ parentPort, workerData } = require("worker_threads"));
} catch (error) {
  // A browser bundle: `self` is the port.
}

const port = parentPort || (typeof self !== "undefined" ? {
  postMessage: (message) => self.postMessage(message),
  on: (_event, callback) =>
    self.addEventListener("message", (event) => callback(event.data)),
} : null);

let jvm = null;
let preloaded = null;

// Classes this worker has been given, so the main thread only sends each one
// once and later requests carry only what changed.
const known = new Set();

// The worker boots from the same classpath as the main thread, so it does not
// have to wait to be told what a class is: it can load one itself. Before
// this, a class missing from the pushed mirror -- for any reason, including a
// send that threw -- refused every method of it forever ("method not mirrored
// in the worker"), and each refusal became a main-thread compile after
// main(). Preloading the whole classpath here is free: nothing observable has
// started, and the guest is not waiting on this thread.
// Compiles must not interleave. Each one moves the shared id allocator to its
// granted base, so a second compile starting inside the first would take ids
// the first was promised. Loading a class is asynchronous, so the handler
// below is a chain rather than a bare listener.
let pending = null;

function start(config) {
  if (jvm) return;
  jvm = new JVM({
    classpath: config?.classpath,
    // The worker compiles and nothing else: no hotness sampling (the main
    // thread owns the queue order), no shadow compiler, and above all no
    // compile worker of its own.
    jit: { ...(config?.jitOptions || {}), compileWorker: false,
      shadowCompile: false, hotness: false, warmupThreshold: 0 },
  });
  preloaded = (async () => {
    try {
      if (typeof jvm.preloadClasspathClasses === "function") {
        await jvm.preloadClasspathClasses();
      }
    } catch (error) {
      // A classpath this worker cannot read is not fatal: it still compiles
      // whatever the main thread pushes to it.
    }
  })();
  pending = preloaded;
  preloaded.then(() => port.postMessage({ type: "ready" }));
}

async function mirrorClass(className) {
  if (jvm.classes[className]?.ast) return true;
  try {
    await jvm.loadClassByName(className);
  } catch (error) {
    return false;
  }
  return !!jvm.classes[className]?.ast;
}

function installClasses(classes) {
  for (const entry of classes || []) {
    if (!entry?.className) continue;
    if (!known.has(entry.className)) {
      known.add(entry.className);
      if (entry.ast) {
        jvm.classes[entry.className] = {
          ast: entry.ast,
          constantPool: entry.constantPool,
          staticFields: new StaticFieldStore(),
        };
      }
    }
    if (entry.initialized) {
      declareStaticKeys(jvm.classes[entry.className]);
      jvm.classInitializationState.set(entry.className, "INITIALIZED");
    }
  }
}

// A worker cannot run <clinit>, so a class it is told is initialized gets its
// static keys declared at their descriptor defaults. Without the keys
// resolveStaticFieldSite finds nothing and every static read in the compiled
// body degrades to the slow path. The VALUES are not the main thread's; every
// value-dependent speculation is re-guarded on arrival.
function declareStaticKeys(classData) {
  const items = classData?.ast?.classes?.[0]?.items || [];
  for (const item of items) {
    if (item?.type !== "field") continue;
    const field = item.field;
    if (!field?.flags?.includes("static")) continue;
    const key = `${field.name}:${field.descriptor}`;
    if (classData.staticFields.has(key)) continue;
    classData.staticFields.set(key, defaultStaticValue(field.descriptor));
  }
}

function defaultStaticValue(descriptor) {
  if (descriptor === "J") return BigInt(0);
  if ("ZBCSIFD".includes(descriptor) && descriptor.length === 1) return 0;
  return null;
}

function findMethod(className, name, descriptor) {
  const items = jvm.classes[className]?.ast?.classes?.[0]?.items || [];
  for (const item of items) {
    if (item?.type === "method" && item.method.name === name &&
        item.method.descriptor === descriptor) {
      return item.method;
    }
  }
  return null;
}

// The granted id range: everything this compile allocates must land inside
// it, because the requester reserved exactly that much room and nothing else
// may take those indices while the request is in flight.
function exceedsGrant(limit) {
  if (!limit) return null;
  const now = jvm.jit.siteIdWatermark();
  for (const table of JitCompiler.transportableSiteTables) {
    if (now[table] > limit[table]) return table;
  }
  return null;
}

function compile(request) {
  const method = findMethod(request.className, request.name,
    request.descriptor);
  if (!method) return { refused: "method not mirrored in the worker" };
  const base = jvm.jit.reserveSiteIdSpace(request.grant);
  // A request is always for a fresh body. This worker may already hold one
  // for the method -- compiled as a side effect of an earlier request, or
  // for an earlier request of the same method that is now being replaced --
  // and serving it would be wrong twice over: its bare site ids belong to
  // that earlier grant (whose entries were described with THAT result, and
  // never placed at all if it was refused), and it was planned without the
  // link state this request carries. Compile again, into this grant.
  jvm.jit.codegenCache.delete(method);
  // The requester's learned link state for this method's call sites, so
  // the worker plans against the same speculation the requester would.
  jvm.jit.seedTransportedWarmth(method, request.warmth);
  let generated;
  try {
    generated = jvm.jit.getGeneratedFunction(method,
      request.preparedWholeMethod ? { allowEffectfulCalls: true } : {});
  } catch (error) {
    return { refused: `compile threw: ${error.message}` };
  } finally {
    jvm.jit.seedTransportedWarmth(method, null);
  }
  if (!generated) return { refused: "the worker's own compiler refused it" };
  const untransportable = jvm.jit.untransportableTableGrowth(base);
  if (untransportable.length) {
    return { refused: `uses untransportable tables [${
      untransportable.join(", ")}]` };
  }
  const overflowed = exceedsGrant(request.limit);
  if (overflowed) {
    return { refused: `outgrew its ${overflowed} id grant` };
  }
  const payload = jvm.jit.serializeGeneratedResult(generated,
    { provenance: request.provenance, siteTablesSince: base });
  if (!payload) return { refused: "result is not serializable" };
  return { payload };
}

async function handle(message) {
  installClasses(message.classes);
  await mirrorClass(message.className);
  try {
    return compile(message);
  } catch (error) {
    return { refused: `worker threw: ${error.message}` };
  }
}

if (port) {
  port.on("message", (message) => {
    if (message?.type === "init") {
      start(message);
      return;
    }
    if (message?.type !== "compile") return;
    // A compile before init can only happen if a host sent one, which no host
    // does; answering rather than throwing keeps the requester's bookkeeping
    // balanced either way.
    if (!jvm) {
      port.postMessage({ type: "result", id: message.id,
        refused: "the worker has not been initialized" });
      return;
    }
    pending = pending.then(async () => {
      let answer;
      try {
        answer = await handle(message);
      } catch (error) {
        answer = { refused: `worker threw: ${error.message}` };
      }
      port.postMessage({ type: "result", id: message.id, ...answer });
    });
  });
}

// `worker_threads` already carries the configuration, so there is nothing to
// wait for. A browser waits for its init message.
if (parentPort) start(workerData);
