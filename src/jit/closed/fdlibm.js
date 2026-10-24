'use strict';

// sin/cos for the closed module, in Wasm: fdlibm's algorithm (the one V8's
// Math.sin/Math.cos implement, src/base/ieee754.cc), so results are bit-for-bit
// those of the JS builtin every other jvm.js tier calls. A host import costs
// ~22 ns per call; GeoBlox's Vorbis decoder calls Math.sin ~10 million times.
//
// Arguments beyond fdlibm's medium range (|x| > 2^19*pi/2) take the JS
// builtin through the `fallback` import: that path needs the multi-word
// __kernel_rem_pio2 and is never hot.

const { VT, OP, f64bytes, sleb } = require('./wasmBuilder');

const X = {
  i64_reinterpret_f64: 0xbd, f64_reinterpret_i64: 0xbf, i64_extend_i32_u: 0xad, i32_trunc_f64_s: 0xaa,
};
const f = (value) => [OP.f64_const, ...f64bytes(value)];
const get = (i) => [OP.local_get, i];
const set = (i) => [OP.local_set, i];
const tee = (i) => [OP.local_tee, i];
const i32 = (value) => [OP.i32_const, ...sleb(value | 0)];
// High word of a double: i32.wrap(i64.reinterpret(x) >>> 32).
const high = (code) => [...code, X.i64_reinterpret_f64, OP.i64_const, 32, OP.i64_shr_u, OP.i32_wrap_i64];

const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
const invpio2 = 6.36619772367581382433e-01, pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11,
  pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21, pio2_3 = 2.02226624871116645580e-21,
  pio2_3t = 8.47842766036889956997e-32;

// __kernel_sin(x, y, iy): params x=0 y=1 iy=2; locals z=3 v=4 r=5 ix=6
function kernelSin() {
  return {
    params: [[VT.f64], [VT.f64], [VT.i32]], results: [[VT.f64]], locals: [[VT.f64], [VT.f64], [VT.f64], [VT.i32]],
    code: [
      ...high(get(0)), ...i32(0x7fffffff), OP.i32_and, ...tee(6), ...i32(0x3e400000), OP.i32_lt_u,
      OP.if, 0x40, ...get(0), OP.return, OP.end,
      ...get(0), ...get(0), OP.f64_mul, ...set(3),
      ...get(3), ...get(0), OP.f64_mul, ...set(4),
      ...f(S2), ...get(3), ...f(S3), ...get(3), ...f(S4), ...get(3), ...f(S5), ...get(3), ...f(S6), OP.f64_mul,
      OP.f64_add, OP.f64_mul, OP.f64_add, OP.f64_mul, OP.f64_add, OP.f64_mul, OP.f64_add, ...set(5),
      ...get(2), OP.i32_eqz, OP.if, 0x40,
      // x + v*(S1 + z*r)
      ...get(0), ...get(4), ...f(S1), ...get(3), ...get(5), OP.f64_mul, OP.f64_add, OP.f64_mul, OP.f64_add, OP.return,
      OP.end,
      // x - ((z*(half*y - v*r) - y) - v*S1)
      ...get(0), ...get(3), ...f(0.5), ...get(1), OP.f64_mul, ...get(4), ...get(5), OP.f64_mul, OP.f64_sub, OP.f64_mul,
      ...get(1), OP.f64_sub, ...get(4), ...f(S1), OP.f64_mul, OP.f64_sub, OP.f64_sub,
    ],
  };
}

// __kernel_cos(x, y): params x=0 y=1; locals ix=2 z=3 r=4 qx=5 hz=6 a=7
function kernelCos() {
  return {
    params: [[VT.f64], [VT.f64]], results: [[VT.f64]], locals: [[VT.i32], [VT.f64], [VT.f64], [VT.f64], [VT.f64], [VT.f64]],
    code: [
      ...high(get(0)), ...i32(0x7fffffff), OP.i32_and, ...tee(2), ...i32(0x3e400000), OP.i32_lt_u,
      OP.if, 0x40, ...f(1), OP.return, OP.end,
      ...get(0), ...get(0), OP.f64_mul, ...set(3),
      ...get(3), ...f(C1), ...get(3), ...f(C2), ...get(3), ...f(C3), ...get(3), ...f(C4), ...get(3), ...f(C5), ...get(3), ...f(C6),
      OP.f64_mul, OP.f64_add, OP.f64_mul, OP.f64_add, OP.f64_mul, OP.f64_add, OP.f64_mul, OP.f64_add, OP.f64_mul, OP.f64_add,
      OP.f64_mul, ...set(4),
      ...get(2), ...i32(0x3fd33333), OP.i32_lt_u, OP.if, 0x40,
      // one - (0.5*z - (z*r - x*y))
      ...f(1), ...f(0.5), ...get(3), OP.f64_mul, ...get(3), ...get(4), OP.f64_mul, ...get(0), ...get(1), OP.f64_mul,
      OP.f64_sub, OP.f64_sub, OP.f64_sub, OP.return,
      OP.end,
      ...get(2), ...i32(0x3fe90000), OP.i32_gt_u, OP.if, 0x40, ...f(0.28125), ...set(5),
      OP.else,
      ...get(2), ...i32(0x00200000), OP.i32_sub, X.i64_extend_i32_u, OP.i64_const, 32, OP.i64_shl, X.f64_reinterpret_i64, ...set(5),
      OP.end,
      ...f(0.5), ...get(3), OP.f64_mul, ...get(5), OP.f64_sub, ...set(6),
      ...f(1), ...get(5), OP.f64_sub, ...set(7),
      // a - (hz - (z*r - x*y))
      ...get(7), ...get(6), ...get(3), ...get(4), OP.f64_mul, ...get(0), ...get(1), OP.f64_mul, OP.f64_sub, OP.f64_sub, OP.f64_sub,
    ],
  };
}

// __ieee754_rem_pio2 for |x| <= 2^19*pi/2 -> (n, y0, y1); n = 0x7fffffff asks
// the caller to use the host for a larger argument.
// params x=0; locals hx=1 ix=2 n=3 y0=4 y1=5 z=6 t=7 r=8 w=9 fn=10 j=11 i=12
function remPio2() {
  const ret = () => [...get(3), ...get(4), ...get(5), OP.return];
  const negOrPos = (sign) => sign > 0 ? OP.f64_sub : OP.f64_add;
  const nearPio2 = (sign) => [ // |x| < 3pi/4, n = +-1
    ...get(0), ...f(pio2_1), negOrPos(sign), ...set(6),
    ...get(2), ...i32(0x3ff921fb), OP.i32_ne, OP.if, 0x40,
    ...get(6), ...f(pio2_1t), negOrPos(sign), ...tee(4), OP.drop,
    ...get(6), ...get(4), OP.f64_sub, ...f(pio2_1t), negOrPos(sign), ...set(5),
    OP.else,
    ...get(6), ...f(pio2_2), negOrPos(sign), ...set(6),
    ...get(6), ...f(pio2_2t), negOrPos(sign), ...set(4),
    ...get(6), ...get(4), OP.f64_sub, ...f(pio2_2t), negOrPos(sign), ...set(5),
    OP.end,
    ...i32(sign), ...set(3), ...ret(),
  ];
  const exponentGap = () => [...get(11), ...high(get(4)), ...i32(20), OP.i32_shr_u, ...i32(0x7ff), OP.i32_and, OP.i32_sub, ...set(12)];
  const iterate = (p, pt) => [ // t = r; w = fn*p; r = t - w; w = fn*pt - ((t - r) - w); y0 = r - w
    ...get(8), ...set(7), ...get(10), ...f(p), OP.f64_mul, ...set(9), ...get(7), ...get(9), OP.f64_sub, ...set(8),
    ...get(10), ...f(pt), OP.f64_mul, ...get(7), ...get(8), OP.f64_sub, ...get(9), OP.f64_sub, OP.f64_sub, ...set(9),
    ...get(8), ...get(9), OP.f64_sub, ...set(4),
  ];
  return {
    params: [[VT.f64]], results: [[VT.i32], [VT.f64], [VT.f64]],
    locals: [[VT.i32], [VT.i32], [VT.i32], [VT.f64], [VT.f64], [VT.f64], [VT.f64], [VT.f64], [VT.f64], [VT.f64], [VT.i32], [VT.i32]],
    code: [
      ...high(get(0)), ...tee(1), ...i32(0x7fffffff), OP.i32_and, ...set(2),
      ...get(2), ...i32(0x3fe921fb), OP.i32_le_u, OP.if, 0x40, ...i32(0), ...set(3), ...get(0), ...set(4), ...f(0), ...set(5), ...ret(), OP.end,
      ...get(2), ...i32(0x4002d97c), OP.i32_lt_u, OP.if, 0x40,
      ...get(1), ...i32(0), OP.i32_gt_s, OP.if, 0x40, ...nearPio2(1), OP.end,
      ...nearPio2(-1),
      OP.end,
      ...get(2), ...i32(0x413921fb), OP.i32_gt_u, OP.if, 0x40, ...i32(0x7fffffff), ...set(3), ...f(0), ...set(4), ...f(0), ...set(5), ...ret(), OP.end,
      // medium: t = |x|; n = (int)(t*invpio2 + half); fn = n
      ...get(0), OP.f64_abs, ...set(7),
      ...get(7), ...f(invpio2), OP.f64_mul, ...f(0.5), OP.f64_add, X.i32_trunc_f64_s, ...tee(3), OP.f64_convert_i32_s, ...set(10),
      ...get(7), ...get(10), ...f(pio2_1), OP.f64_mul, OP.f64_sub, ...set(8),
      ...get(10), ...f(pio2_1t), OP.f64_mul, ...set(9),
      // The quick "no cancellation" shortcut gives the same y0 as this
      // exponent check (it only skips it), so it is omitted.
      ...get(2), ...i32(20), OP.i32_shr_u, ...set(11),
      ...get(8), ...get(9), OP.f64_sub, ...set(4),
      ...exponentGap(),
      ...get(12), ...i32(16), OP.i32_gt_s, OP.if, 0x40,
      ...iterate(pio2_2, pio2_2t),
      ...exponentGap(),
      ...get(12), ...i32(49), OP.i32_gt_s, OP.if, 0x40, ...iterate(pio2_3, pio2_3t), OP.end,
      OP.end,
      ...get(8), ...get(4), OP.f64_sub, ...get(9), OP.f64_sub, ...set(5),
      ...get(1), ...i32(0), OP.i32_lt_s, OP.if, 0x40,
      ...get(4), OP.f64_neg, ...set(4), ...get(5), OP.f64_neg, ...set(5), ...i32(0), ...get(3), OP.i32_sub, ...set(3),
      OP.end,
      ...ret(),
    ],
  };
}

// sin/cos(x): params x=0; locals ix=1 n=2 y0=3 y1=4
function trig(isSin, keys) {
  const kSin = (sign) => [...get(3), ...get(4), ...i32(1), OP.call, { fn: keys.kernelSin }, ...(sign < 0 ? [OP.f64_neg] : [])];
  const kCos = (sign) => [...get(3), ...get(4), OP.call, { fn: keys.kernelCos }, ...(sign < 0 ? [OP.f64_neg] : [])];
  // quadrant n&3: sin -> [sin, cos, -sin, -cos], cos -> [cos, -sin, -cos, sin]
  const arms = isSin ? [kSin(1), kCos(1), kSin(-1), kCos(-1)] : [kCos(1), kSin(-1), kCos(-1), kSin(1)];
  return {
    params: [[VT.f64]], results: [[VT.f64]], locals: [[VT.i32], [VT.i32], [VT.f64], [VT.f64]],
    code: [
      ...high(get(0)), ...i32(0x7fffffff), OP.i32_and, ...tee(1), ...i32(0x3fe921fb), OP.i32_le_u, OP.if, 0x40,
      ...(isSin ? [...get(0), ...f(0), ...i32(0), OP.call, { fn: keys.kernelSin }] : [...get(0), ...f(0), OP.call, { fn: keys.kernelCos }]),
      OP.return, OP.end,
      ...get(1), ...i32(0x7ff00000), OP.i32_ge_u, OP.if, 0x40, ...get(0), ...get(0), OP.f64_sub, OP.return, OP.end,
      ...get(0), OP.call, { fn: keys.remPio2 }, ...set(4), ...set(3), ...tee(2),
      ...i32(0x7fffffff), OP.i32_eq, OP.if, 0x40, ...get(0), OP.call, { fn: keys.fallback }, OP.return, OP.end,
      ...get(2), ...i32(3), OP.i32_and, ...set(2),
      ...get(2), OP.i32_eqz, OP.if, 0x40, ...arms[0], OP.return, OP.end,
      ...get(2), ...i32(1), OP.i32_eq, OP.if, 0x40, ...arms[1], OP.return, OP.end,
      ...get(2), ...i32(2), OP.i32_eq, OP.if, 0x40, ...arms[2], OP.return, OP.end,
      ...arms[3],
    ],
  };
}

// Adds the functions to a ModuleBuilder (after its imports) and returns the
// key of `which` ('sin' | 'cos'). `fallbackKey(name)` must name an imported
// (f64)->f64 host function computing the same thing.
function defineTrig(builder, which, fallbackKey) {
  const keys = { kernelSin: 'fdlibm:kernel_sin', kernelCos: 'fdlibm:kernel_cos', remPio2: 'fdlibm:rem_pio2' };
  const ensure = (key, body) => {
    if (builder.functions.some((fn) => fn.key === key)) return;
    builder.declareFunction(key, body.params, body.results);
    builder.defineFunction(key, body.locals, body.code);
  };
  ensure(keys.kernelSin, kernelSin());
  ensure(keys.kernelCos, kernelCos());
  ensure(keys.remPio2, remPio2());
  const key = `fdlibm:${which}`;
  ensure(key, trig(which === 'sin', { ...keys, fallback: fallbackKey(which) }));
  return key;
}

module.exports = { defineTrig };
