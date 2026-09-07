// G0 kernel benchmark: ck.a(III[I[IIIIIIIIII)V (Deko Bloko additive sprite blit).
// Runs in the SpiderMonkey shell: js bench_blit.js <dir>
const dir = scriptArgs[0];
const ONLY = scriptArgs[1]; const ROUNDS = Number(scriptArgs[2] || 7), CALLS = Number(scriptArgs[3] || 400);
const W = 640, H = 480, SW = 96, SH = 96, ALPHA = 128;
const DX = 100, DY = 100;
const srcIdx = 0, dstIdx = DY * W + DX, negW = SW, negH = SH, dstStep = W - SW, srcStep = 0; // names kept: the bytecode negates locals 9,10 itself
const PX = SW * SH;

// deterministic sprite: 20% transparent (0), else random ARGB-ish rgb
let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) | 0, (seed >>> 8) & 0xffffff);
const spriteInit = new Int32Array(PX); for (let i = 0; i < PX; i++) spriteInit[i] = (rnd() % 5 === 0) ? 0 : (rnd() & 0xffffff);
const rasterInit = new Int32Array(W * H); for (let i = 0; i < W * H; i++) rasterInit[i] = rnd() & 0x3f3f3f;

const checksum = (a) => { let h = 0; for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + (a[i] | 0)) | 0; return h; };

// ---- Variant A: jvm.js restoring-positional tier body, helpers stubbed ----
const bodySrc = read(dir + "/blit.generated_jvmRestoringDirectPositionalBody.full.js");
const guard = { classEpoch: 0, initializationEpoch: 0 };
const ASYNC = { async: true }, RETVOID = undefined;
const factory = new Function("ssaLinkClassGuard0", "ssaAsyncInvoke", "ssaReturnVoid", "return " + bodySrc);
const jvmBody = factory(guard, ASYNC, RETVOID);
const helpers = {
  profileMethods: false, needsBytecodeChecks: () => false,
  jvm: { classEpoch: 0, classInitializationEpoch: 0 },
  structuredSsa: { verifyClassInitializationGuard: () => true, safePointCount: 0 },
  continueStructuredQuantum: () => true, materialize() {}, skipJitOnce() {},
  arrayLoad() { throw new Error("slow path"); },
};
const thread = { callStack: { items: [] }, status: "runnable" };
const guestArray = (typed, init) => { // jvm.js int[]: plain Array (heap off) or typed view (heap on), plus tag props
  const a = typed ? new Int32Array(init) : Array.from(init);
  a.type = "[I"; a.elementType = "int"; a.hashCode = 1; return a;
};
function makeA(typed) {
  const dst = guestArray(typed, rasterInit), src = guestArray(typed, spriteInit);
  return {
    name: typed ? "A2 jvm.js tier, Int32Array (wasmHeap on)" : "A1 jvm.js tier, plain Array (wasmHeap off)",
    run() { const r = jvmBody(helpers, null, 0, 0, 0, dst, src, srcIdx, 0, dstIdx, 0, negW, negH, dstStep, srcStep, ALPHA, thread, 0); if (r === ASYNC) throw new Error("deopt"); },
    sum() { return checksum(dst); },
  };
}

// ---- Variant B: hand JS over Int32Array (Ion best case) ----
function handBlit(dst, src, si, di, negW, negH, dstStep, srcStep, alpha) {
  for (let y = negH; y > 0; y--) {
    for (let x = negW; x > 0; x--) {
      let p = src[si++];
      if (p !== 0) {
        let l1 = Math.imul(p & 0xFF00FF, alpha);
        p = ((l1 & 0xFF00FF00) + ((Math.imul(p, alpha) - l1) & 0xFF0000)) >>> 8;
        const d = dst[di]; const s = (p + d) | 0;
        const l0 = ((p & 0xFF00FF) + (d & 0xFF00FF)) | 0;
        l1 = ((l0 & 0x1000100) + ((s - l0) & 0x10000)) | 0;
        dst[di++] = (s - l1) | (l1 - (l1 >>> 8));
      } else di++;
    }
    di += dstStep; si += srcStep;
  }
}
function makeB(typed) {
  const dst = typed ? new Int32Array(rasterInit) : Array.from(rasterInit), src = typed ? new Int32Array(spriteInit) : Array.from(spriteInit);
  return { name: typed ? "B2 hand JS, Int32Array" : "B1 hand JS, plain Array", run() { handBlit(dst, src, srcIdx, dstIdx, negW, negH, dstStep, srcStep, ALPHA); }, sum() { return checksum(dst); } };
}

// ---- Variant C: hand Wasm, arrays in linear memory, no imports ----
const wasmBytes = os.file.readFile(dir + "/blit.wasm", "binary");
const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
const mem = new Int32Array(inst.exports.mem.buffer);
const DST_ADDR = 4096, SRC_ADDR = DST_ADDR + W * H * 4 + 4096;
function makeC() {
  mem.set(rasterInit, DST_ADDR >> 2); mem.set(spriteInit, SRC_ADDR >> 2);
  const blit = inst.exports.blit;
  return { name: "C  hand Wasm, linear memory", run() { blit(DST_ADDR, SRC_ADDR, srcIdx, dstIdx, negW, negH, dstStep, srcStep, ALPHA); }, sum() { return checksum(mem.subarray(DST_ADDR >> 2, (DST_ADDR >> 2) + W * H)); } };
}

const all = { A1: () => makeA(false), A2: () => makeA(true), B1: () => makeB(false), B2: () => makeB(true), C: () => makeC() };
const variants = (ONLY ? [ONLY] : Object.keys(all)).map((k) => all[k]());
// correctness: identical raster after the same number of blits
const sums = variants.map((v) => { for (let i = 0; i < 3; i++) v.run(); return v.sum(); });
print("checksums after 3 blits:", sums.join(" "), sums.every((s) => s === sums[0]) ? "(all equal)" : "(MISMATCH)");

function bench(v) {
  for (let i = 0; i < 200; i++) v.run(); // warm up / tier up
  const times = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < CALLS; i++) v.run();
    times.push((performance.now() - t0) * 1e6 / (CALLS * PX));
  }
  times.sort((a, b) => a - b);
  return { min: times[0], med: times[times.length >> 1] };
}
const results = variants.map((v) => ({ name: v.name, ...bench(v) }));
const base = results[0];
print("\nns per source pixel (" + PX + " px/blit, " + CALLS + " blits x " + ROUNDS + " rounds)");
for (const r of results) print(`  ${r.name.padEnd(46)} min ${r.min.toFixed(2)}  median ${r.med.toFixed(2)}`);
