"use strict";

// Main-thread half of the Phase 1.2 compile worker. It owns the queue, the
// id-space grants and the installation of an arriving body; the worker half
// (compileWorkerThread.js) only compiles.
//
// The point of the phase is that the main thread stops compiling: a method
// that is not yet compiled runs in the interpreter/baseline tier while its
// body is built elsewhere, and the queue order -- hotness first -- decides
// what gets built next.

const path = require("path");

// How much id room one in-flight request is granted in each transportable
// table. Two results must never claim the same indices, so the requester
// reserves a disjoint range up front and the worker refuses a compile that
// outgrows it (the method is then compiled locally, which is rare enough to
// be a diagnostic rather than a policy).
const DEFAULT_GRANT_STRIDE = 512;

// How many sends in a row may fail before the client gives up entirely.
const CONSECUTIVE_FAILURE_LIMIT = 8;

class CompileWorkerClient {
  constructor(jit, options = {}) {
    const environment = (typeof process !== "undefined" && process.env)
      ? process.env : {};
    this.jit = jit;
    this.jvm = jit.jvm;
    // On by default. Compiling after main() is the cost this phase exists to
    // remove, so the worker is the normal path and not an experiment: with
    // ahead-of-time preparation it drains before the guest starts, and
    // afterwards it keeps whatever still compiles off the main thread.
    //
    // An explicit false still wins -- the worker builds a JVM of its own and
    // must be able to say "not you" -- and JVM_JIT_COMPILE_WORKER=0 turns it
    // off, which is what an A/B needs to produce evidence at all.
    this.enabled = options.compileWorker === true ||
      (options.compileWorker !== false &&
        environment.JVM_JIT_COMPILE_WORKER !== "0");
    this.grantStride = Math.max(64, Number(
      options.compileWorkerGrantStride ||
      environment.JVM_JIT_COMPILE_WORKER_STRIDE || DEFAULT_GRANT_STRIDE));
    this.maxInFlight = Math.max(1, Number(
      options.compileWorkerInFlight ||
      environment.JVM_JIT_COMPILE_WORKER_INFLIGHT || 4));
    this.worker = null;
    // Where a browser can fetch the bundled worker script. Node derives its
    // path from __dirname; a page cannot.
    this.workerUrl = options.compileWorkerUrl ||
      environment.JVM_JIT_COMPILE_WORKER_URL || null;
    this.nextRequestId = 1;
    this.queue = [];
    this.queued = new Set();
    this.inFlight = new Map();
    this.sentClasses = new Set();
    this.sentInitialized = new Set();
    // Classes that cannot be structured-cloned, so must never be offered
    // again, and the methods the worker has already declined once.
    this.unsendableClasses = new Set();
    this.declined = new WeakSet();
    // Of those, the ones the WORKER itself turned down after considering them.
    // A send that never reached a worker is a different thing entirely: there
    // is no queue doing the work elsewhere, so the local compiler is still the
    // only way the method ever gets a body. Section 0.2's rule is about a
    // queue that exists and said no; it is not a licence to strand a method
    // on a host that has no worker at all (a browser, for one, where
    // `worker_threads` does not exist and every send throws).
    this.declinedByRefusal = new WeakSet();
    // How often each queued method has been asked for again. A precompile
    // seed is asked once; a method the guest is running is asked every time
    // it misses the cache.
    this.demand = new WeakMap();
    // Consecutive failed sends. A worker that cannot be reached at all must
    // not be reconstructed once per queued method: past this many failures in
    // a row the client switches itself off and the JIT compiles normally.
    this.consecutiveSendFailures = 0;
    this.idleWaiters = [];
    this.stats = { queued: 0, requested: 0, completed: 0, installed: 0,
      refused: 0, stale: 0, staleRetried: 0, superseded: 0, failed: 0,
      refusedReasons: {}, staleReasons: {} };
    this.lastRefusal = null;
    // Methods whose bodies this worker actually delivered and published, so a
    // test can prove a transported body ran rather than a local fallback.
    this.installedMethods = new WeakSet();
    if (environment.JVM_JIT_COMPILE_WORKER_STATS === "1") {
      const timer = setInterval(() => {
        const w = this.jit.siteIdWatermark();
        process.stderr.write("[cw] " + JSON.stringify({
          ...this.stats, queue: this.queue.length,
          inFlight: this.inFlight.size,
          syncCallSites: w.syncCallSites, fieldSites: w.fieldSites,
          last: this.lastRefusal, sendError: this.firstSendError }) + "\n");
      }, 5000);
      if (timer.unref) timer.unref();
    }
  }

  // The stated objective is fps in a browser, and a browser has no
  // `worker_threads`. Requiring it unconditionally meant every send threw on
  // exactly the host the target is defined for, so the whole mechanism of
  // Phase 1 -- compiling somewhere other than the thread the guest runs on --
  // was absent there and only ever exercised in Node. The two hosts differ in
  // how a worker is constructed and how a message is delivered, and in
  // nothing above that, so that is all this adapter covers. It presents the
  // `worker_threads` shape because the protocol was written against it.
  ensureWorker() {
    if (this.worker) return this.worker;
    const host = this.createNodeWorkerHost() || this.createBrowserWorkerHost();
    if (!host) {
      // No host can build one. Throwing is what the caller already handles:
      // the method goes back to the local compiler, which is the right answer
      // when there is no second thread to hand it to.
      throw new Error("no compile worker host available " +
        "(no worker_threads, and no compile worker script URL configured)");
    }
    this.worker = host;
    host.onMessage((message) => this.receive(message));
    host.onError((error) => {
      // A dead worker must not stop the JVM: every queued method simply
      // compiles on the main thread again.
      this.lastRefusal = `worker error: ${error.message}`;
      this.stats.failed += this.inFlight.size;
      this.inFlight.clear();
      this.worker = null;
      this.settleIdle();
    });
    // The worker must not hold the process open while it is idle, but it
    // must keep it open while a request is outstanding -- otherwise Node can
    // exit between the send and the reply and the body silently never lands.
    this.worker.unref();
    return this.worker;
  }

  createNodeWorkerHost() {
    let Worker = null;
    try {
      // Bundlers resolve this to an empty object rather than failing, so the
      // shape has to be checked and not merely the require.
      ({ Worker } = require("worker_threads"));
    } catch (error) {
      return null;
    }
    if (typeof Worker !== "function") return null;
    const worker = new Worker(
      path.join(__dirname, "compileWorkerThread.js"),
      { workerData: { classpath: this.jvm.classpath,
        jitOptions: this.jvm.jitOptions || {} } });
    return {
      kind: "worker_threads",
      postMessage: (message) => worker.postMessage(message),
      onMessage: (callback) => worker.on("message", callback),
      onError: (callback) => worker.on("error", callback),
      ref: () => worker.ref(),
      unref: () => worker.unref(),
      terminate: () => worker.terminate(),
    };
  }

  createBrowserWorkerHost() {
    const scope = typeof globalThis !== "undefined" ? globalThis : null;
    const WorkerConstructor = scope && scope.Worker;
    if (typeof WorkerConstructor !== "function") return null;
    // Only the page knows where its own bundle lives, so the script URL is
    // configuration, not something this file can derive. Its absence is a
    // configuration fact and not a failure: the JIT then compiles exactly as
    // it did before there was a worker at all.
    const url = this.workerUrl || (scope && scope.JVM_COMPILE_WORKER_URL);
    if (!url) return null;
    const worker = new WorkerConstructor(url, { name: "jvm-compile-worker" });
    // `workerData` has no browser equivalent, so the same payload is the
    // first message instead. It is sent before any compile request, and
    // postMessage preserves order, so the worker has it in time.
    worker.postMessage({ type: "init", classpath: this.jvm.classpath,
      jitOptions: this.jvm.jitOptions || {} });
    return {
      kind: "web-worker",
      postMessage: (message) => worker.postMessage(message),
      onMessage: (callback) =>
        worker.addEventListener("message", (event) => callback(event.data)),
      onError: (callback) => worker.addEventListener("error", (event) =>
        callback(event.error || new Error(event.message || "worker error"))),
      // A browser worker does not keep anything alive and cannot exit the
      // page between a send and its reply, so there is nothing to hold.
      ref: () => {},
      unref: () => {},
      terminate: () => Promise.resolve(worker.terminate()),
    };
  }

  // Everything the worker has not been told about yet. A class crosses once;
  // its initialization is reported whenever it changes to INITIALIZED.
  pendingClasses() {
    const classes = [];
    for (const [className, classData] of Object.entries(this.jvm.classes)) {
      const initialized =
        this.jvm.classInitializationState.get(className) === "INITIALIZED";
      const isNew = !this.sentClasses.has(className);
      const newlyInitialized = initialized &&
        !this.sentInitialized.has(className);
      if (!isNew && !newlyInitialized) continue;
      if (isNew && !classData?.ast) continue;
      if (this.unsendableClasses.has(className)) continue;
      classes.push({ className, initialized,
        // postMessage structured-clones these; an AST that cannot cross makes
        // the send throw, which is why nothing is marked delivered until the
        // send has actually returned.
        ast: isNew ? classData.ast : undefined,
        constantPool: isNew ? classData.constantPool : undefined });
    }
    return classes;
  }

  // A batch counts as delivered only once postMessage has returned. Marking
  // it beforehand loses every class in a send that throws: the worker never
  // receives them, the client never offers them again, and every later
  // request for one of their methods is refused as "not mirrored".
  commitClasses(classes) {
    for (const entry of classes) {
      this.sentClasses.add(entry.className);
      if (entry.initialized) this.sentInitialized.add(entry.className);
    }
  }

  // The worker has had its turn at this method and could not deliver a body.
  // Retrying is pointless -- every refusal here is deterministic -- and
  // leaving it queued would strand the method in the interpreter forever, so
  // it goes back to the main thread's own compiler.
  decline(method, { refused = false } = {}) {
    this.declined.add(method);
    if (refused) this.declinedByRefusal.add(method);
    this.queued.delete(method);
  }

  // Called when a send throws. Structured clone is all-or-nothing, so the
  // batch says only that SOMETHING in it cannot cross; this finds which,
  // quarantines those classes, and lets the rest be offered again.
  quarantineUnsendable(classes) {
    const rejected = [];
    for (const entry of classes) {
      try {
        structuredClone(entry);
      } catch (error) {
        this.unsendableClasses.add(entry.className);
        rejected.push(entry.className);
      }
    }
    if (rejected.length) {
      this.lastRefusal = `quarantined ${rejected.length} unsendable ` +
        `class(es): ${rejected.slice(0, 4).join(", ")}`;
    }
    return rejected;
  }

  // A method the main thread would have compiled. Returns true when the
  // worker has taken it, so the caller can leave the method interpreted.
  enqueue(method, options = {}) {
    if (!this.enabled || this.declined.has(method)) return false;
    if (this.queued.has(method) || this.inFlight.has(method)) {
      // Already the worker's problem. Counting the re-ask is what lets a
      // method the guest is actually running overtake the precompile seeds
      // queued ahead of it.
      const pending = this.demand.get(method) || 0;
      this.demand.set(method, pending + 1);
      return true;
    }
    const className = this.jvm.findClassNameForMethod?.(method) ||
      method.className;
    if (!className) return false;
    this.queued.add(method);
    this.demand.set(method, 1);
    this.queue.push({ method, className,
      // Receiving-runtime identity only: never transported to the worker.
      // Publication may replace this exact body, but never a newer winner.
      replacementOf: options.replacementOf || null,
      preparedWholeMethod: options.preparedWholeMethod === true });
    this.stats.queued += 1;
    this.pump();
    return true;
  }

  // Hotness decides what compiles next, exactly as the phase asks: no
  // threshold admits a method, the queue order does. Without the sampler the
  // queue is first-come.
  nextRequest() {
    if (!this.queue.length) return null;
    const sampled = this.jit.hotness && this.jit.hotness.size > 0;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < this.queue.length; index += 1) {
      const method = this.queue[index].method;
      // With the sampler on, its score is the better signal. Without it,
      // demand is: `precompileInitializedClasses` walks every method of every
      // loaded class, so a FIFO queue puts thousands of cold seeds ahead of
      // the handful of methods the guest is executing right now, and their
      // bodies arrive tens of seconds late or not at all.
      const score = sampled
        ? (this.jit.hotness.get(method)?.score || 0)
        : (this.demand.get(method) || 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return this.queue.splice(bestIndex, 1)[0];
  }

  pump() {
    if (!this.enabled) return;
    while (this.queue.length && this.inFlight.size < this.maxInFlight) {
      const entry = this.nextRequest();
      if (!entry) return;
      this.queued.delete(entry.method);
      const id = this.nextRequestId++;
      const grant = this.jit.siteIdWatermark();
      const limit = { ...grant };
      for (const table of this.jit.constructor.transportableSiteTables) {
        limit[table] = grant[table] + this.grantStride;
      }
      const classes = this.pendingClasses();
      entry.warmth = this.jit.describeCallSiteWarmth(entry.method);
      this.inFlight.set(entry.method, { id, entry });
      try {
        this.ensureWorker().postMessage({
          type: "compile", id,
          className: entry.className,
          name: entry.method.name,
          descriptor: entry.method.descriptor,
          preparedWholeMethod: entry.preparedWholeMethod,
          provenance: this.jit.captureResultProvenance(),
          grant, limit,
          classes,
          // What this thread has learned at the method's call sites. The
          // worker plans against it; the copy kept on the in-flight record
          // pre-links the body's sites when it lands.
          warmth: entry.warmth,
        });
        // Only a send that returned has promised anything. Reserving the id
        // range on this side after it -- nothing else runs in between --
        // means a throwing send costs no ids, and the classes it carried are
        // offered again on the next request.
        this.jit.reserveSiteIdSpace(limit);
        this.commitClasses(classes);
        this.stats.requested += 1;
        this.consecutiveSendFailures = 0;
        this.worker.ref();
      } catch (error) {
        // A class that cannot be structured-cloned, or a dead worker. The
        // method goes back to the main thread rather than being retried.
        this.inFlight.delete(entry.method);
        if (!this.firstSendError) this.firstSendError = error.message;
        // Find what could not cross, drop it, and put the method back at the
        // head of the queue: the classes it still needs will be offered again
        // on the next send. Only a second failure retires the method.
        const rejected = this.quarantineUnsendable(classes);
        if (rejected.length && !entry.retriedAfterQuarantine) {
          entry.retriedAfterQuarantine = true;
          this.queued.add(entry.method);
          this.queue.unshift(entry);
          continue;
        }
        this.stats.failed += 1;
        this.lastRefusal = `send failed: ${error.message}`;
        this.decline(entry.method);
        this.consecutiveSendFailures += 1;
        if (this.consecutiveSendFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          this.enabled = false;
          this.lastRefusal = `disabled after ${
            this.consecutiveSendFailures} consecutive send failures ` +
            `(last: ${error.message})`;
          for (const queued of this.queue) this.declined.add(queued.method);
          this.queue.length = 0;
          this.queued.clear();
          this.dispose();
          return;
        }
      }
    }
    this.settleIdle();
  }

  receive(message) {
    if (message?.type === "ready") return;
    if (message?.type !== "result") return;
    let found = null;
    let foundRecord = null;
    for (const [method, record] of this.inFlight) {
      if (record.id === message.id) {
        found = method;
        foundRecord = record;
        break;
      }
    }
    if (found === null) return;
    this.inFlight.delete(found);
    if (message.refused) {
      this.stats.refused += 1;
      this.stats.completed += 1;
      const key = this.classifyRefusalReason(message.refused);
      this.stats.refusedReasons[key] = (this.stats.refusedReasons[key] || 0) + 1;
      this.lastRefusal = message.refused;
      this.decline(found, { refused: true });
    } else {
      // Task 2: everything from here to publication is main-thread work done
      // after the worker result arrived. It is an *attempt* regardless of the
      // outcome; only a successful publish is an *install*.
      const installStart = this.jit.monotonicNow();
      const timings = { validationMs: 0, descriptorBindingMs: 0,
        newFunctionMs: 0, wasmInstantiationMs: 0 };
      const generated = this.jit.materializeGeneratedResult(
        message.payload, found,
        { timings, warmth: foundRecord?.entry?.warmth || null });
      const materializeMs = this.jit.monotonicNow() - installStart;
      if (!generated) {
        this.stats.stale += 1;
        this.stats.completed += 1;
        const reason = this.jit.lastStaleTransportReason ||
          this.jit.lastTransportRefusal || "rejected on arrival";
        const key = this.classifyStaleReason(reason);
        this.stats.staleReasons[key] = (this.stats.staleReasons[key] || 0) + 1;
        this.lastRefusal = reason;
        // Validation (and any descriptor binding done before the reject) still
        // occupied the main thread, so it is counted as an attempt.
        this.jit.recordResultInstallTiming(
          { ...timings, publicationMs: 0, totalInstallMs: materializeMs },
          { installed: false });
        // Staleness is a lost race, not a verdict. The worker built this body
        // against a site table or static target that had moved by the time it
        // landed; asked again it may well succeed, which is exactly unlike a
        // refusal, where the worker has examined the method and cannot ever
        // build it. Retiring a method on one stale result costs it its tier
        // for the rest of the run -- and after main() nobody else will build
        // it, so it stays in the tier it happened to have. So retry it once,
        // the same bounded shape `retriedAfterQuarantine` uses for a failed
        // send, and only a second staleness retires it. 1.5: bounded retries,
        // not unbounded ones, and not zero.
        const entry = foundRecord && foundRecord.entry;
        if (entry && !entry.retriedAfterStale) {
          entry.retriedAfterStale = true;
          this.stats.staleRetried += 1;
          this.queued.add(found);
          this.queue.push(entry);
          this.pump();
        } else {
          this.decline(found, { refused: true });
        }
      } else if (!this.jit.codegenCache.get(found) ||
          (foundRecord?.entry?.replacementOf &&
            this.jit.codegenCache.get(found) === foundRecord.entry.replacementOf)) {
        // Publish exactly as a local compile would, so callers relink through
        // the ordinary upgrade path rather than a second mechanism.
        const publicationStart = this.jit.monotonicNow();
        this.jit.codegenCache.set(found, generated);
        if (foundRecord?.entry?.preparedWholeMethod) {
          this.jit.preparedCodegenMethods.add(found);
        }
        this.jit.publishGeneratedTargetUpgrade?.(found, generated);
        const publicationMs = this.jit.monotonicNow() - publicationStart;
        const totalInstallMs = this.jit.monotonicNow() - installStart;
        this.jit.recordResultInstallTiming({ ...timings,
          publicationMs, totalInstallMs }, { installed: true });
        this.installedMethods.add(found);
        this.stats.installed += 1;
        this.stats.completed += 1;
      } else {
        // The method already has a body (a local compile won the race). The
        // result is discarded; its materialization cost is real main-thread
        // work but it is not an install.
        this.stats.superseded += 1;
        this.stats.completed += 1;
        this.jit.recordResultInstallTiming(
          { ...timings, publicationMs: 0, totalInstallMs: materializeMs },
          { installed: false });
      }
    }
    this.pump();
  }

  // Normalize the free-form refusal strings the worker sends into stable
  // keys, so a run reports aggregate counts instead of a log someone has to
  // parse. Unknown reasons fall through to a slug of the raw text.
  classifyRefusalReason(reason) {
    const r = String(reason || "unknown");
    if (r.startsWith("method not mirrored")) return "method-not-mirrored";
    if (r.startsWith("uses untransportable tables")) return "untransportable-table";
    if (r.startsWith("outgrew its")) return "grant-overflow";
    if (r.startsWith("result is not serializable")) return "not-serializable";
    if (r.startsWith("the worker's own compiler refused")) return "worker-compiler-refused";
    if (r.startsWith("compile threw:")) return "compile-threw";
    if (r.startsWith("worker threw:")) return "worker-threw";
    return this.slugReason(r);
  }

  classifyStaleReason(reason) {
    const r = String(reason || "rejected on arrival");
    if (r.startsWith("class epoch moved")) return "class-epoch-moved";
    if (r.includes(" is not initialized on this thread")) {
      return "initialization-assumption";
    }
    if (r.startsWith("result carries no provenance")) return "no-provenance";
    if (r.startsWith("region call site target not resolvable")) {
      return "region-call-site-unresolved";
    }
    if (r.startsWith("field site ") || r.startsWith("call site ")) {
      return "site-conflict";
    }
    if (r === "rejected on arrival") return "rejected-on-arrival";
    return this.slugReason(r);
  }

  slugReason(reason) {
    const slug = String(reason).replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "").toLowerCase();
    return slug || "unknown";
  }

  get idle() {
    return this.queue.length === 0 && this.inFlight.size === 0;
  }

  // One plain object for the benchmark: worker census plus the JIT's install
  // and synchronous-compile accounting (docs/phase1-worker-audit.md).
  census() {
    return {
      worker: { ...this.stats },
      install: this.jit.installCensus(),
      syncCompile: this.jit.syncCompileCensus(),
    };
  }

  settleIdle() {
    if (!this.idle) return;
    if (this.worker) this.worker.unref();
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // For tests and for a shutdown that wants every queued body installed.
  whenIdle() {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  dispose() {
    if (!this.worker) return Promise.resolve();
    const worker = this.worker;
    this.worker = null;
    return worker.terminate();
  }
}

module.exports = { CompileWorkerClient };
