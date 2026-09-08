"use strict";

// The compile worker of docs/plan-linear-runtime.md Phase 1.2, run in process
// and synchronously (Phase 1.4's test double). It exists so the whole message
// protocol -- request, shadow-JVM compile, plain-data result, interning on the
// receiving JIT -- can be exercised by the ordinary test suite and by a real
// game boot, with no browser and no thread.
//
// The shadow is a SEPARATE JVM. It gets its own structured clone of each class
// AST (exactly what postMessage would hand a Worker), its own StaticFieldStore,
// and its own JitCompiler with its own site-id tables. Nothing it produces may
// reference one of its live objects: a result crosses as the plain data of
// JitCompiler.serializeGeneratedResult and is rebuilt by
// materializeGeneratedResult against the receiving JIT's own tables.
//
// A shadow JVM cannot run <clinit>, so for every class the request reports
// INITIALIZED it declares that class's static keys with their default values.
// Without them resolveStaticFieldSite finds no key and the generated body
// degrades to the getStaticSyncAt slow path.
// Every ShadowCompiler in the process accumulates into this, so a whole test
// run (which builds hundreds of JVMs) can report one transport rate.
// JVM_JIT_SHADOW_COMPILE_REPORT=<file> writes it at exit.
const globalStats = {
  instances: 0, requests: 0, transported: 0, stale: 0, notSerializable: 0,
  shadowRejected: 0, errors: 0, payloadBytes: 0, reasons: Object.create(null),
  tierMatches: 0, tierMismatches: 0, tierDiffs: Object.create(null),
};

let reportInstalled = false;
function installGlobalReport() {
  if (reportInstalled) return;
  const target = typeof process !== "undefined" && process.env
    ? process.env.JVM_JIT_SHADOW_COMPILE_REPORT : null;
  if (!target) return;
  reportInstalled = true;
  process.on("exit", () => {
    try {
      const top = (table, count) => Object.fromEntries(Object.entries(table)
        .sort((a, b) => b[1] - a[1]).slice(0, count));
      require("fs").appendFileSync(target, JSON.stringify({
        ...globalStats,
        reasons: top(globalStats.reasons, 25),
        tierDiffs: top(globalStats.tierDiffs, 25),
      }) + "\n");
    } catch (_) { /* a report must never fail a run */ }
  });
}

class ShadowCompiler {
  constructor(jit, options = {}) {
    const environment = (typeof process !== "undefined" && process.env)
      ? process.env : {};
    this.jit = jit;
    this.jvm = jit.jvm;
    // An explicit `false` must win over the environment: the shadow JVM is
    // constructed with shadowCompile:false while JVM_JIT_SHADOW_COMPILE=1 is
    // still set in the environment it inherits. Letting the variable override
    // that gives the shadow a shadow of its own, without bound.
    this.enabled = options.shadowCompile === true ||
      (options.shadowCompile !== false &&
        environment.JVM_JIT_SHADOW_COMPILE === "1");
    // Strict mode turns every silent fallback into a thrown error, so a test
    // run cannot report success while quietly compiling on the main thread.
    this.strict = options.shadowCompileStrict === true ||
      environment.JVM_JIT_SHADOW_COMPILE_STRICT === "1";
    // The plain-data constraint a structured clone imposes, asserted on every
    // result instead of only in the dedicated test.
    this.verifyPlainData = options.shadowCompileVerifyPlainData === true ||
      environment.JVM_JIT_SHADOW_COMPILE_VERIFY === "1";
    // Diff mode also compiles locally and compares the two tier selections.
    // A worker that silently picks a weaker tier than the main thread would
    // is a correctness-preserving but performance-destroying outcome, and it
    // is invisible unless something compares them.
    this.diffTiers = options.shadowCompileDiffTiers === true ||
      environment.JVM_JIT_SHADOW_COMPILE_DIFF === "1";
    // A local compile is not free and registers its own sites, so each method
    // is compared once and the whole diagnostic is capped.
    this.diffBudget = Number(
      environment.JVM_JIT_SHADOW_COMPILE_DIFF_BUDGET || 200);
    this.diffed = new Set();
    this.shadow = null;
    this.mirroredClasses = new Set();
    this.compiling = false;
    this.stats = {
      requests: 0, transported: 0, localFallback: 0, stale: 0,
      notSerializable: 0, shadowRejected: 0, errors: 0, payloadBytes: 0,
    };
    this.lastError = null;
    if (this.enabled) {
      globalStats.instances += 1;
      installGlobalReport();
    }
  }

  // The shadow JVM is created on first use: constructing one costs a full JRE
  // bootstrap, which a run that never compiles should not pay.
  ensureShadow() {
    if (this.shadow) return this.shadow;
    const { JVM } = require("../core/jvm");
    this.shadow = new JVM({
      classpath: this.jvm.classpath,
      // The shadow compiles; it never schedules guest code, and it must not
      // recursively start a shadow of its own.
      jit: { ...(this.jvm.jitOptions || {}), shadowCompile: false,
        hotness: false, warmupThreshold: 0 },
    });
    return this.shadow;
  }

  // Give the shadow its own copy of every class the main JVM has registered
  // since the last request, and mirror the initialization state the compile is
  // allowed to assume.
  syncWorld() {
    const shadow = this.ensureShadow();
    for (const [className, classData] of Object.entries(this.jvm.classes)) {
      if (this.mirroredClasses.has(className)) continue;
      this.mirroredClasses.add(className);
      if (!classData?.ast) continue;
      let ast;
      let constantPool;
      try {
        ast = structuredClone(classData.ast);
        constantPool = classData.constantPool
          ? structuredClone(classData.constantPool) : undefined;
      } catch (_) {
        // A class whose AST cannot cross a structured clone cannot be given to
        // a worker at all; leave it unmirrored and let its compiles fall back.
        continue;
      }
      const { StaticFieldStore } = require("../core/StaticFieldStore");
      shadow.classes[className] = { ast, constantPool,
        staticFields: new StaticFieldStore() };
    }
    for (const [className, state] of this.jvm.classInitializationState) {
      if (state !== "INITIALIZED") continue;
      if (shadow.classInitializationState.get(className) === "INITIALIZED") {
        continue;
      }
      const classData = shadow.classes[className];
      if (classData?.ast) this.declareStaticKeys(classData);
      shadow.classInitializationState.set(className, "INITIALIZED");
    }
    return shadow;
  }

  declareStaticKeys(classData) {
    const items = classData.ast?.classes?.[0]?.items || [];
    for (const item of items) {
      if (item?.type !== "field") continue;
      const field = item.field;
      if (!field?.flags?.includes("static")) continue;
      const key = `${field.name}:${field.descriptor}`;
      if (classData.staticFields.has(key)) continue;
      classData.staticFields.set(key, this.defaultStaticValue(field.descriptor));
    }
  }

  defaultStaticValue(descriptor) {
    if (descriptor === "J") return BigInt(0);
    if (descriptor === "Z" || descriptor === "B" || descriptor === "C" ||
        descriptor === "S" || descriptor === "I" || descriptor === "F" ||
        descriptor === "D") {
      return 0;
    }
    return null;
  }

  findShadowMethod(className, name, descriptor) {
    const classData = this.shadow.classes[className];
    const items = classData?.ast?.classes?.[0]?.items || [];
    for (const item of items) {
      if (item?.type === "method" && item.method.name === name &&
          item.method.descriptor === descriptor) {
        return item.method;
      }
    }
    return null;
  }

  fail(reason, counter) {
    this.stats[counter] += 1;
    globalStats[counter] += 1;
    // Group by shape, not by method identity, so the report names causes.
    const shape = reason.replace(/^\S+ /, "").slice(0, 80);
    globalStats.reasons[shape] = (globalStats.reasons[shape] || 0) + 1;
    this.lastError = reason;
    if (this.strict) throw new Error(`shadow compile: ${reason}`);
    return null;
  }

  // The whole request/response cycle for one method. Returns a generated
  // object built on the MAIN jit from plain data, or null to compile locally.
  compile(method, options = {}) {
    if (!this.enabled || this.compiling) return null;
    this.compiling = true;
    try {
      this.stats.requests += 1;
      globalStats.requests += 1;
      const className = this.jvm.findClassNameForMethod?.(method) ||
        method.className;
      if (!className) return this.fail("no owning class", "shadowRejected");
      const shadow = this.syncWorld();
      // The request. Everything the worker may assume is in here; it reads no
      // other state of the main thread.
      const request = {
        className,
        name: method.name,
        descriptor: method.descriptor,
        preparedWholeMethod: options.preparedWholeMethod === true,
        // The world the worker may assume, captured before the compile. The
        // result is stamped with exactly this, so the arrival check compares
        // the requesting thread's world then against its world now.
        provenance: this.jit.captureResultProvenance(),
        // The id space this compile is granted. Everything the shadow
        // allocates from here on sits above every id the requester already
        // uses, so the result's table entries can be placed at exactly the
        // indices its generated text names.
        siteIdWatermark: this.jit.siteIdWatermark(),
        // The link state the requester has learned at this method's call
        // sites by running it. The shadow plans against it; the requester
        // pre-links the arriving body's sites from it.
        warmth: this.jit.describeCallSiteWarmth(method),
      };
      const shadowMethod = this.findShadowMethod(
        request.className, request.name, request.descriptor);
      if (!shadowMethod) {
        return this.fail(`${className}.${method.name} not mirrored`,
          "shadowRejected");
      }
      const grantedBase = shadow.jit.reserveSiteIdSpace(request.siteIdWatermark);
      // A request is for a fresh body: a shadow body left from an earlier
      // request carries that request's site ids and none of this one's link
      // state (see compileWorkerThread.compile).
      shadow.jit.codegenCache.delete(shadowMethod);
      shadow.jit.seedTransportedWarmth(shadowMethod, request.warmth);
      let generated;
      try {
        generated = shadow.jit.getGeneratedFunction(shadowMethod,
          request.preparedWholeMethod ? { allowEffectfulCalls: true } : {});
      } catch (error) {
        return this.fail(`shadow compile threw: ${error.message}`, "errors");
      } finally {
        shadow.jit.seedTransportedWarmth(shadowMethod, null);
      }
      if (!generated) {
        return this.fail(`${className}.${method.name} refused by the shadow`,
          "shadowRejected");
      }
      // A body that allocated into a table the protocol cannot carry must not
      // be installed: its generated text names ids that mean something else
      // here. Compile it locally instead.
      const untransportable =
        shadow.jit.untransportableTableGrowth(grantedBase);
      if (untransportable.length) {
        return this.fail(
          `${className}.${method.name} uses untransportable tables ` +
          `[${untransportable.join(", ")}]`, "notSerializable");
      }
      let payload = shadow.jit.serializeGeneratedResult(generated,
        { provenance: request.provenance, siteTablesSince: grantedBase });
      if (!payload) {
        return this.fail(`${className}.${method.name} is not serializable`,
          "notSerializable");
      }
      if (this.verifyPlainData) {
        // Exactly the constraint postMessage imposes.
        const text = JSON.stringify(payload);
        this.stats.payloadBytes += text.length;
        globalStats.payloadBytes += text.length;
        payload = JSON.parse(text);
      }
      const materialized = this.jit.materializeGeneratedResult(payload, method,
        { warmth: request.warmth });
      if (!materialized) {
        this.stats.stale += 1;
        globalStats.stale += 1;
        globalStats.reasons["stale on arrival"] =
          (globalStats.reasons["stale on arrival"] || 0) + 1;
        this.lastError = this.jit.lastStaleTransportReason ||
          "result rejected on arrival";
        if (this.strict) throw new Error(`shadow compile: ${this.lastError}`);
        return null;
      }
      if (this.diffTiers && this.diffBudget > 0 && !this.diffed.has(method)) {
        this.diffed.add(method);
        this.diffBudget -= 1;
        this.compareTiers(method, options, materialized);
      }
      this.stats.transported += 1;
      globalStats.transported += 1;
      return materialized;
    } finally {
      this.compiling = false;
    }
  }

  // The tier a body actually publishes, as plain flags.
  static tierSignature(generated) {
    if (!generated) return "none";
    const flags = [];
    if (generated.jvmStructuredSsa) flags.push("structured");
    if (generated.jvmScalarLoop) flags.push("scalar");
    if (generated.jvmResumeBody) flags.push("resume");
    if (generated.jvmStructuredContinuation) flags.push("continuation");
    if (typeof generated.jvmRestoringDirectPositionalBody === "function") {
      flags.push("restoring");
    }
    if (typeof generated.jvmDirectPositionalBody === "function") {
      flags.push("direct");
    }
    if (typeof generated.jvmCheckedLeafDirectPositionalBody === "function") {
      flags.push("checkedLeaf");
    }
    if (typeof generated.jvmAdaptivePositionalBody === "function") {
      flags.push("adaptive");
    }
    return flags.length ? flags.join("+") : "baseline";
  }

  // `this.compiling` is still set, so this reaches the ordinary local path.
  compareTiers(method, options, transported) {
    let local = null;
    try {
      local = this.jit._compileMethodUntimed(method, options);
    } catch (_) {
      return;
    }
    const here = ShadowCompiler.tierSignature(local);
    const there = ShadowCompiler.tierSignature(transported);
    if (here === there) {
      globalStats.tierMatches += 1;
      return;
    }
    globalStats.tierMismatches += 1;
    const reason = this.shadow.jit.structuredSsa.lastRejectionReason ||
      "(no rejection recorded)";
    const key = `local=${here} shadow=${there} :: ${reason}`;
    globalStats.tierDiffs[key] = (globalStats.tierDiffs[key] || 0) + 1;
  }

  report() {
    return { ...this.stats, lastError: this.lastError };
  }
}

module.exports = { ShadowCompiler, globalStats };
