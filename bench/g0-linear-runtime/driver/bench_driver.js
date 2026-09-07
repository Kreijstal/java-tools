// G0 driver benchmark: fh.a(IIZI)V + callees. js bench_driver.js <dir> <variant> [rounds] [frames]
const dir = scriptArgs[0], ONLY = scriptArgs[1] || "all";
const ROUNDS = Number(scriptArgs[2] || 7), FRAMES = Number(scriptArgs[3] || 30);
const W = 640, H = 480, NPART = 48;
let seed = 777; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) | 0, (seed >>> 8) & 0xffffff);
const rbInit = new Int32Array(NPART); for (let i = 0; i < NPART; i++) rbInit[i] = (rnd() << 8) | (rnd() & 0xff) | ((rnd() & 0xff) << 16) | ((rnd() & 0x7f) << 24);
const sin = new Int32Array(2048), cos = new Int32Array(2048);
for (let i = 0; i < 2048; i++) { sin[i] = Math.round(Math.sin(i * Math.PI / 1024) * 65536); cos[i] = Math.round(Math.cos(i * Math.PI / 1024) * 65536); }
const rasterInit = new Int32Array(W * H); for (let i = 0; i < W * H; i++) rasterInit[i] = rnd() & 0x3f3f3f;
const BBF = 1234;
const checksum = (a) => { let h = 0; for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + (a[i] | 0)) | 0; return h; };

// ---------------- hand JS (Int32Array raster/tables, plain objects for statics) ----------------
function makeHandJs() {
  const hk = { c: 0, g: W, h: 0, b: H, j: W, l: new Int32Array(rasterInit) };
  const ok = { b: 0, h: 0, d: 0, f: null, e: 0, g: 0, a: 0, c: 0 };
  const rb = { n: rbInit }, bb = { f: BBF }, client = { A: false }, qg = { b: sin, f: cos };
  const ke_a = (p0, p1) => { if (p0 !== 2047) {} return qg.b[p1 & 2047]; };
  const h_a = (p0, p1) => { if (p1 !== -122) {} return qg.f[p0 & 2047]; };
  function hk_c(x, y, w, color, alpha) {
    if (y < hk.h || y >= hk.b) return;
    if (x < hk.c) { w -= hk.c - x; x = hk.c; }
    if (x + w > hk.g) w = hk.g - x;
    const l5 = 256 - alpha;
    const l6 = ((color >> 16) & 255) * alpha, l7 = ((color >> 8) & 255) * alpha, l8 = (color & 255) * alpha;
    let l12 = x + y * hk.j; const l = hk.l;
    for (let i = 0; i < w; i++) {
      const p = l[l12];
      const l9 = ((p >> 16) & 255) * l5, l10 = ((p >> 8) & 255) * l5, l11 = (p & 255) * l5;
      l[l12++] = (((l6 + l9) >> 8) << 16) + (((l7 + l10) >> 8) << 8) + ((l8 + l11) >> 8);
    }
  }
  function ok_b_sort(lo, hi) {
    const f = ok.f;
    while (hi >= lo + 8) {
      let sorted = 1;
      for (let i = lo + 4; i < hi; i += 4) {
        const a = f[i - 4], b = f[i];
        if (a > b) { sorted = 0; f[i - 4] = b; f[i] = a; let t = f[i - 2]; f[i - 2] = f[i + 2]; f[i + 2] = t; t = f[i - 1]; f[i - 1] = f[i + 3]; f[i + 3] = t; }
      }
      if (sorted) return;
      hi -= 4;
    }
  }
  function ok_a_qsort(lo, hi) {
    if (hi <= lo + 4) return;
    const f = ok.f; let l2 = lo; const l3 = f[l2], l4 = f[l2 + 1], l5 = f[l2 + 2], l6 = f[l2 + 3];
    for (let l7 = lo + 4; l7 < hi; l7 += 4) {
      const l8 = f[l7 + 1];
      if (l8 < l4) {
        f[l2] = f[l7]; f[l2 + 1] = l8; f[l2 + 2] = f[l7 + 2]; f[l2 + 3] = f[l7 + 3]; l2 += 4;
        f[l7] = f[l2]; f[l7 + 1] = f[l2 + 1]; f[l7 + 2] = f[l2 + 2]; f[l7 + 3] = f[l2 + 3];
      }
    }
    f[l2] = l3; f[l2 + 1] = l4; f[l2 + 2] = l5; f[l2 + 3] = l6;
    ok_a_qsort(lo, l2); ok_a_qsort(l2 + 4, hi);
  }
  function ok_a_setup() {
    if (ok.d < 0) { ok.g = 0; ok.b = 0; ok.c = 0; ok.h = 2147483646; return; }
    ok_a_qsort(0, ok.d);
    const f = ok.f; let l0 = f[1]; if (l0 < hk.h) l0 = hk.h;
    let l2 = 0;
    for (; l2 < ok.d; l2 += 4) {
      const l3 = f[l2 + 1]; if (l0 < l3) break;
      const l4 = f[l2], l5 = f[l2 + 2], l6 = f[l2 + 3];
      const l7 = (((l5 - l4) << 16) / (l6 - l3)) | 0;
      f[l2] = ((l4 << 16) + 32768) + Math.imul(l0 - l3, l7); f[l2 + 2] = l7;
    }
    ok.c = 0; ok.b = l2; ok.g = l2; ok.h = l0 - 1;
  }
  function ok_b_step() {
    const f = ok.f; let l0 = ok.b, l1 = ok.g, l2 = ok.h;
    for (;;) {
      if (l1 < l0) { ok.a = f[l1] >> 16; ok.e = f[l1 + 4] >> 16; f[l1] += f[l1 + 2]; f[l1 + 4] += f[l1 + 6]; l1 += 8; ok.g = l1; return true; }
      l2++; ok.h = l2;
      if (l2 >= hk.b) return false;
      let l3 = ok.c;
      while (l0 < ok.d) {
        const l4 = f[l0 + 1]; if (l2 < l4) break;
        const l5 = f[l0], l6 = f[l0 + 2], l7 = f[l0 + 3];
        f[l0] = (l5 << 16) + 32768; f[l0 + 2] = (((l6 - l5) << 16) / (l7 - l4)) | 0; l0 += 4;
      }
      for (let l4 = l3; l4 < l0; l4 += 4) {
        if (l2 >= f[l4 + 3]) { f[l4] = f[l3]; f[l4 + 1] = f[l3 + 1]; f[l4 + 2] = f[l3 + 2]; f[l4 + 3] = f[l3 + 3]; l3 += 4; }
      }
      if (l3 === ok.d) { ok.d = 0; return false; }
      ok_b_sort(l3, l0); ok.c = l3; ok.b = l0; l1 = l3;
    }
  }
  function ok_a_fill(color, alpha, l2, l3) {
    ok_a_setup();
    while (ok_b_step()) {
      let l4 = ok.a, l5 = ok.e; const l6 = ok.h;
      if (l2 !== null) { const l7 = l6 - hk.h; if (l4 < l2[l7] + hk.c) l4 = l2[l7] + hk.c; if (l5 > l2[l7] + l3[l7] + hk.c) l5 = l2[l7] + l3[l7] + hk.c; }
      hk_c(l4, l6, l5 - l4, color, alpha);
    }
  }
  function ok_b_edges(pts, off, len) {
    const l3 = ok.d + (len << 1);
    if (ok.f === null || ok.f.length < l3) { const nf = new Int32Array(l3); for (let i = 0; i < ok.d; i++) nf[i] = ok.f[i]; ok.f = nf; }
    const f = ok.f; len += off; let l4 = len - 2;
    for (let l5 = off; l5 < len; l5 += 2) {
      const l6 = pts[l4 + 1], l7 = pts[l5 + 1];
      if (l6 < l7) { f[ok.d++] = pts[l4]; f[ok.d++] = l6; f[ok.d++] = pts[l5]; f[ok.d++] = l7; }
      else if (l7 < l6) { f[ok.d++] = pts[l5]; f[ok.d++] = l7; f[ok.d++] = pts[l4]; f[ok.d++] = l6; }
      l4 = l5;
    }
  }
  function ok_a7(pts, off, len, color, alpha, l5, l6) { if (l5 !== null && hk.b - hk.h !== l5.length) throw new Error(); ok.d = 0; ok_b_edges(pts, off, len); ok_a_fill(color, alpha, l5, l6); }
  const ok_a3 = (pts, color, alpha) => ok_a7(pts, 0, pts.length, color, alpha, null, null);
  function fh_a(p0, p1, p2, p3) {
    const A = client.A; if (p2 !== true) return;
    const n = rb.n;
    for (let l6 = 0; (l6 ^ -1) > (n.length ^ -1);) {
      const v = n[l6];
      const l7 = (v >> 8) & 255, l8 = 255 & (v >> 24);
      const l9 = ((2048 * l7) >> 8) - (-((bb.f * (1 + l8)) >> 6));
      const l10 = (v >> 16) & 255, l11 = 255 & v;
      const l12 = ke_a(2047, l9) >> 6, l13 = h_a(l9, -122) >> 6, l14 = ke_a(2047, l11 + l9) >> 6, l15 = h_a(l9 + l11, -122) >> 6;
      const arr = new Int32Array(6); arr[0] = 320 + p3; arr[1] = p0 - (-490); arr[2] = l12 + p3; arr[3] = p0 + l13; arr[4] = p3 - (-l14); arr[5] = l15 + p0;
      if (A) return;
      if (256 !== p1) ok_a3(arr, 16777215, (l10 * 256) >> 9); else ok_a3(arr, 16777215, l10);
      l6++; if (A) break;
    }
  }
  return { name: "B  hand JS (Int32Array, direct calls)", frame() { fh_a(0, 200, true, 0); }, sum() { return checksum(hk.l); } };
}

// ---------------- hand Wasm, linear memory ----------------
function makeWasm() {
  const bytes = os.file.readFile(dir + "/driver.wasm", "binary");
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const ex = inst.exports; const mem = new Int32Array(ex.mem.buffer);
  ex.heap.value = 65536;
  const mkArr = (src) => { const a = ex.alloc(src.length); mem.set(src, (a >> 2) + 1); return a; };
  ex.hk_l.value = mkArr(rasterInit); ex.hk_c.value = 0; ex.hk_g.value = W; ex.hk_h.value = 0; ex.hk_b.value = H; ex.hk_j.value = W;
  ex.rb_n.value = mkArr(rbInit); ex.qg_b.value = mkArr(sin); ex.qg_f.value = mkArr(cos); ex.bb_f.value = BBF; ex.client_A.value = 0;
  const rasterOff = (ex.hk_l.value >> 2) + 1; const frameHeap = ex.heap.value;
  return { name: "C  hand Wasm (linear memory, direct calls)", frame() { ex.heap.value = frameHeap; ex.ok_f.value = 0; ex.fh_a(0, 200, 1, 0); }, sum() { return checksum(mem.subarray(rasterOff, rasterOff + W * H)); } };
}

const all = { B: makeHandJs, C: makeWasm };
if (ONLY.startsWith("A")) { load(dir + "/jvmjs_variant.js"); all.A1 = () => makeJvmJs(false); all.A2 = () => makeJvmJs(true); }
const variants = (ONLY === "all" ? Object.keys(all) : ONLY.split(",")).map((k) => all[k]());
for (const v of variants) { v.frame(); v.frame(); print("checksum after 2 frames", v.name, ":", v.sum()); }
function bench(v) {
  for (let i = 0; i < 40; i++) v.frame();
  const times = [];
  for (let r = 0; r < ROUNDS; r++) { const t0 = performance.now(); for (let i = 0; i < FRAMES; i++) v.frame(); times.push((performance.now() - t0) * 1e3 / FRAMES); }
  times.sort((a, b) => a - b); return { min: times[0], med: times[times.length >> 1] };
}
for (const v of variants) { const r = bench(v); print(`  ${v.name.padEnd(48)} us/frame min ${r.min.toFixed(1)}  median ${r.med.toFixed(1)}  ${v.stats ? v.stats() : ""}`); }
