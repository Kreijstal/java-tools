// "Today" variant for bench_driver.js: jvm.js generated bodies (dumped from the
// booted game with JVM_DUMP_GENERATED_DIR + JVM_DUMP_GENERATED_CAPTURES) bound
// to stub runtime records the way JitCompiler binds them. TYPED selects the
// int[] representation: plain Array (linear heap off) or Int32Array (heap on).
function makeJvmJs(TYPED) {
  const GEN = dir + "/gamegen/";
  const ASYNC = { async: true }, RETVOID = { returnVoid: true }, STATIC_DEOPT = { staticDeopt: true };
  let slowArrayOps = 0, coldPaths = 0;
  const guestArray = (count, init) => {
    const a = TYPED ? new Int32Array(count) : new Array(count).fill(0);
    if (init) for (let i = 0; i < count; i++) a[i] = init[i];
    a.type = "[I"; a.elementType = "int"; a.hashCode = (guestArray.h = (guestArray.h | 0) + 1); return a;
  };
  // ---- statics: one value cell per (class, key), shared by every site ----
  const cells = new Map();
  const cell = (cls, key) => { const k = cls + "\0" + key; if (!cells.has(k)) cells.set(k, { value: null }); return cells.get(k); };
  const raster = guestArray(W * H, rasterInit);
  cell("client", "A:Z").value = 0; cell("rb", "n:[I").value = guestArray(NPART, rbInit); cell("bb", "f:I").value = BBF;
  cell("qg", "b:[I").value = guestArray(2048, sin); cell("qg", "f:[I").value = guestArray(2048, cos);
  cell("hk", "c:I").value = 0; cell("hk", "g:I").value = W; cell("hk", "h:I").value = 0; cell("hk", "b:I").value = H; cell("hk", "j:I").value = W; cell("hk", "l:[I").value = raster;
  for (const k of ["b:I", "h:I", "d:I", "e:I", "g:I", "a:I", "c:I"]) cell("ok", k).value = 0;
  cell("ok", "f:[I").value = null; cell("ke", "h:[I").value = null; cell("h", "f:Ljava/lang/String;").value = null;
  const directStaticTargets = new Proxy({}, { get: () => ({ versionCell: { captureCaches: null } }) });
  // ---- runtime stubs (helpers === jit) ----
  const thread = { status: "runnable", callStack: { items: [], peek() { return this.items[this.items.length - 1]; }, push(f) { this.items.push(f); }, pop() { return this.items.pop(); } } };
  const helpers = {
    profileMethods: false, profileTimings: false, generatedDeoptTrace: false, debugPositionalDepth: false,
    syncReusedFrameCount: 0, referenceFramelessPositionalRunCount: 0, compiledCallChainRunCount: 0,
    jvm: { classEpoch: 0, classInitializationEpoch: 0, debugManager: { jitDeoptedClassCount: 0 }, enterFrameMonitorIfNeeded: () => true, exitFrameMonitor() {} },
    structuredSsa: { verifyClassInitializationGuard: () => true, safePointCount: 0, guardedBooleanFallbackCount: 0,
      restoreDirectFrame() { coldPaths++; throw new Error("cold: restoreDirectFrame"); }, materializeDirectFrame() { coldPaths++; return [null, [], []]; }, materializeUnwindFrame() { coldPaths++; throw new Error("cold: materializeUnwindFrame"); }, releaseUnwindFrame() {} },
    needsBytecodeChecks: () => false, continueStructuredQuantum: () => true, materialize() {}, skipJitOnce() {},
    returnVoid: () => RETVOID, asyncInvokeSentinel: () => ASYNC, staticDeopt: STATIC_DEOPT,
    shouldBeginExclusiveTimingKey: () => false, endExclusiveTiming() {},
    arrayLength: (a) => a.length,
    arrayLoad(index, arr) { slowArrayOps++; const a = arr.elements || arr; if (index >>> 0 >= a.length) throw new Error("AIOOBE"); return a[index]; },
    arrayStore(value, index, arr) { slowArrayOps++; const a = arr.elements || arr; if (index >>> 0 >= a.length) throw new Error("AIOOBE"); a[index] = value; },
    newPrimitiveArray: (count, type) => guestArray(count),
    directStaticTargets, markStaticTargetChanged() {},
    tryInvokeSyncAt(id) { throw new Error("unlinked call site " + id); },
    linkStructuredCallChild() { coldPaths++; throw new Error("cold: linkStructuredCallChild"); },
    tryCheckCastSourceSync() { throw new Error("cold: checkcast"); }, newObjectSync() { throw new Error("cold: new"); },
  };
  class Frame { constructor(method) { this.method = method; this.stack = { items: [] }; this.isSynchronizedMethod = false; this.monitorObject = null; this.monitorEntered = false; this.monitorOwnerThreadId = -1; this.locals = new Array(method.localsSize).fill(undefined); this.instructions = method.instructions; this.exceptionTable = []; this.pc = 0; this.className = undefined; this.jitSkipOnce = undefined; this.jitJsDisabled = undefined; this.jitAdaptiveEntryCounted = undefined; this.jitGeneratedReturnParent = undefined; this.jitGeneratedReturnType = undefined; this.jitStableGeneratedEntry = undefined; this.jvmResumeHandoffs = undefined; this.jitFrameHandoffTrace = undefined; this.initializingClassName = undefined; this.inUse = false; this.resumedAt = undefined; } }
  // ---- bodies ----
  const methods = {
    "fh.a(IIZI)V":          { file: "fh.a_IIZI_V.structured-ssa", framed: true, params: 4, localsSize: 18 },
    "ke.a(II)I":            { file: "ke.a_II_I.ssa-direct-restoring-positional", params: 2 },
    "h.a(IB)I":             { file: "h.a_IB_I.ssa-direct-restoring-positional", params: 2 },
    "ok.a([III)V":          { file: "ok.a__III_V.ssa-direct-restoring-positional", params: 3 },
    "ok.a([IIIII[I[I)V":    { file: "ok.a__IIIII_I_I_V.structured-ssa", framed: true, entry: "ok.a__IIIII_I_I_V.positional-entry", params: 7, localsSize: 8 },
    "ok.a(II[I[I)V":        { file: "ok.a_II_I_I_V.ssa-direct-restoring-positional", params: 4 },
    "ok.b()Z":              { file: "ok.b__Z.ssa-direct-restoring-positional", params: 0 },
    "ok.a()V":              { file: "ok.a__V.ssa-direct-restoring-positional", params: 0 },
    "ok.a(II)V":            { file: "ok.a_II_V.ssa-direct-restoring-positional", params: 2 },
    "ok.b(II)V":            { file: "ok.b_II_V.ssa-direct-restoring-positional", params: 2 },
    "ok.b([III)V":          { file: "ok.b__III_V.ssa-direct-restoring-positional", params: 3 },
    "ok.c()V":              { file: "ok.c__V.ssa-direct-restoring-positional", params: 0 },
    "hk.c(IIIII)V":         { file: "hk.c_IIIII_V.ssa-direct-restoring-positional", params: 5 },
  };
  const sites = []; // call-site records to link once every body exists
  const bindCaptures = (file) => {
    const sidecar = JSON.parse(read(GEN + file + ".captures.json"));
    const names = ["ssaAsyncInvoke", "ssaReturnVoid"], values = [ASYNC, RETVOID];
    for (const [name, d] of Object.entries(sidecar)) {
      let v;
      if (d.kind === "staticCell") v = cell(d.className, d.key);
      else if (d.kind === "callSite") { v = { fastPositional: null, key: `${d.className}.${d.methodName}${d.descriptor}` }; sites.push(v); }
      else if (d.kind === "classGuard") v = { owners: d.owners, classEpoch: 0, initializationEpoch: 0 };
      else continue;
      names.push(name); values.push(v);
    }
    return { names, values };
  };
  const compile = (key, m) => {
    const src = read(GEN + m.file + ".js");
    const { names, values } = bindCaptures(m.file);
    const args = Array.from({ length: m.params }, (_, i) => "argument" + i);
    const tier = m.file.slice(m.file.indexOf(".", m.file.indexOf(".") + 1) + 1).replace(/-/g, "_");
    const owner = key.slice(0, key.indexOf(".")), rest = key.slice(key.indexOf(".") + 1);
    const fname = `jvm$${tier}$${owner}$${rest.replace(/[^\w]/g, "_")}`; // runtime naming: self-recursive links use it
    let head;
    if (m.framed) head = `${src.includes("yield") ? "function*" : "function"} ${fname}(frame, thread, helpers, initialBytecodeChecks, framelessEntry)`;
    else head = `function ${fname}(helpers, plan, ${args.concat(["thread", "nestedEntryGuarded"]).join(", ")})`;
    const body = new Function(...names, `"use strict"; return ${head} {\n${src}\n}`)(...values);
    return body;
  };
  const bodies = {};
  for (const [key, m] of Object.entries(methods)) bodies[key] = compile(key, m);
  // ---- positional invokers, exactly as getPositionalGeneratedInvoker binds them ----
  const invokers = {};
  for (const [key, m] of Object.entries(methods)) {
    if (!m.framed) {
      const plan = { target: {}, Frame, method: null, lookupClass: key.slice(0, key.indexOf(".")), clearStructuredContinuation: null, semantic: null, restoreFrame() {} };
      const inv = bodies[key].bind(null, helpers, plan);
      inv.jvmDebugGuarded = true; inv.jvmRestoresExceptionFrames = true;
      invokers[key] = inv;
    } else if (m.entry) {
      const src = read(GEN + m.entry + ".js");
      const args = Array.from({ length: m.params }, (_, i) => "argument" + i);
      const entry = new Function("plan", ...args, "thread", src);
      const method = { localsSize: m.localsSize, instructions: [] };
      const plan = { jit: helpers, target: { freeFrame: null, preferFrameless: true }, Frame, method, methodKey: key, generated: bodies[key],
        clearStructuredContinuation: null, canonicalGeneratedBody: bodies[key], exclusiveTier: "structured", framelessMode: 1, framelessBody: bodies[key],
        compiledCallChain: false, referenceFrameless: false, adaptiveThreshold: 4, adaptiveYieldThreshold: 4, lookupClass: "ok", staticOwner: "ok",
        staticInitialization: { initialized: true }, asyncInvoke: ASYNC, returnVoid: RETVOID, restoreFrame() {}, describe: (v) => typeof v };
      const inv = entry.bind(null, plan); inv.jvmCanonicalFrameAdapter = true;
      invokers[key] = inv;
    }
  }
  if (typeof SWAP_HKC !== "undefined" && SWAP_HKC) { // attribution: hand-JS span leaf under the jvm.js driver chain
    const cH = cell("hk", "h:I"), cB = cell("hk", "b:I"), cC = cell("hk", "c:I"), cG = cell("hk", "g:I"), cJ = cell("hk", "j:I"), cL = cell("hk", "l:[I");
    const hand = (x, y, w, color, alpha) => {
      const l = cL.value;
      if (y < cH.value || y >= cB.value) return RETVOID;
      if (x < cC.value) { w -= cC.value - x; x = cC.value; }
      if (x + w > cG.value) w = cG.value - x;
      const l5 = 256 - alpha, l6 = ((color >> 16) & 255) * alpha, l7 = ((color >> 8) & 255) * alpha, l8 = (color & 255) * alpha;
      let i = x + y * cJ.value;
      for (let k = 0; k < w; k++) { const p = l[i]; l[i++] = ((((l6 + ((p >> 16) & 255) * l5) >> 8) << 16) + (((l7 + ((p >> 8) & 255) * l5) >> 8) << 8) + ((l8 + (p & 255) * l5) >> 8)); }
      return RETVOID;
    };
    hand.jvmRestoresExceptionFrames = true; invokers["hk.c(IIIII)V"] = hand;
  }
  for (const s of sites) {
    if (!invokers[s.key]) { s.fastPositional = null; continue; } // exception-path sites (StringBuilder, IllegalStateException) stay unlinked
    s.fastPositional = { invoke: invokers[s.key], rawInvoke: null, receiverType: null };
  }
  // ---- driver entry: fh.a runs framed (structured-ssa tier), as the game runs it ----
  const fhMethod = { localsSize: 18, instructions: [] };
  const fh = bodies["fh.a(IIZI)V"];
  function frame() {
    const f = new Frame(fhMethod);
    f.locals[0] = 0; f.locals[1] = 200; f.locals[2] = true; f.locals[3] = 0;
    thread.callStack.items.length = 0; thread.callStack.items.push(f);
    const it = fh(f, thread, helpers, false, false);
    const r = typeof it.next === "function" ? it.next().value : it;
    if (!r || r.deopt || !r.returned) throw new Error("fh.a did not complete: " + JSON.stringify(r));
  }
  return { name: TYPED ? "A2 jvm.js tiers, Int32Array (wasmHeap on)" : "A1 jvm.js tiers, plain Array (wasmHeap off)", frame, sum() { return checksum(raster); },
    stats: () => `slowArrayOps=${slowArrayOps} coldPaths=${coldPaths}` };
}
