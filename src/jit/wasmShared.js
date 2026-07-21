'use strict';

// Shared wasm-emission substrate for every wasm tier (the block-dispatcher
// MethodTranslator and the structured backend): type tags, opcode bytes,
// LEB/float encoders, descriptor mapping, boundary value coercion, and the
// module assembler. Pure data/functions — no JVM state.

const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, ref: 0x6f };
const CAT2 = new Set([T.i64, T.f64]);

const OP = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b,
  br: 0x0c, br_if: 0x0d, br_table: 0x0e, return: 0x0f, call: 0x10,
  drop: 0x1a, select: 0x1b,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22,
  ref_null: 0xd0, ref_is_null: 0xd1,
  i32_const: 0x41, i64_const: 0x42, f32_const: 0x43, f64_const: 0x44,
  i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_gt_s: 0x4a,
  i32_le_s: 0x4c, i32_ge_s: 0x4e,
  i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_gt_s: 0x55,
  i64_le_s: 0x57, i64_ge_s: 0x59,
  f32_eq: 0x5b, f32_ne: 0x5c, f32_lt: 0x5d, f32_gt: 0x5e, f32_le: 0x5f, f32_ge: 0x60,
  f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_rem_s: 0x6f,
  i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
  i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_rem_s: 0x81,
  i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
  f32_neg: 0x8c, f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94, f32_div: 0x95,
  f64_neg: 0x9a, f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3,
  i32_wrap_i64: 0xa7, i64_extend_i32_s: 0xac,
  f32_convert_i32_s: 0xb2, f32_convert_i64_s: 0xb4, f32_demote_f64: 0xb6,
  f64_convert_i32_s: 0xb7, f64_convert_i64_s: 0xb9, f64_promote_f32: 0xbb,
  i32_extend8_s: 0xc0, i32_extend16_s: 0xc1,
};
// saturating truncation (0xFC prefix) — matches Java's NaN->0 / clamping f2i family
const TRUNC_SAT = {
  i32_f32: [0xfc, 0x00], i32_f64: [0xfc, 0x02],
  i64_f32: [0xfc, 0x04], i64_f64: [0xfc, 0x06],
};

function uleb(n) {
  n = Number(n);
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function sleb(value) {
  let n = BigInt(value);
  const out = [];
  for (;;) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0n && !signBit) || (n === -1n && signBit)) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return out;
}

function f32bytes(v) {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, Math.fround(v), true);
  return [buf.getUint8(0), buf.getUint8(1), buf.getUint8(2), buf.getUint8(3)];
}

function f64bytes(v) {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, v, true);
  return [...new Uint8Array(buf.buffer)];
}

function wasmProfilerName(className, method) {
  return `jvm$wasm$${className || 'unknown'}$${method?.name || 'unknown'}${method?.descriptor || ''}`
    .replace(/[^A-Za-z0-9_$]/g, '_');
}

function wasmFunctionNameSection(functionIndex, functionName) {
  const asciiName = [...functionName].map((character) => character.charCodeAt(0) & 0x7f);
  const association = [1, ...uleb(functionIndex), ...uleb(asciiName.length), ...asciiName];
  const subsection = [1, ...uleb(association.length), ...association];
  const sectionName = [0x6e, 0x61, 0x6d, 0x65]; // "name"
  const content = [sectionName.length, ...sectionName, ...subsection];
  return [0, ...uleb(content.length), ...content];
}

function getOp(ins) { return typeof ins === 'string' ? ins : ins && ins.op; }

function descToWasm(ch) {
  switch (ch) {
    case 'I': case 'Z': case 'B': case 'C': case 'S': return T.i32;
    case 'J': return T.i64;
    case 'F': return T.f32;
    case 'D': return T.f64;
    default: return T.ref; // L..; and [..
  }
}

function toWasmValue(t, value) {
  if (t === T.i64) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    return 0n;
  }
  if (t === T.f32) return Math.fround(typeof value === 'number' ? value : 0);
  if (t === T.f64 || t === T.i32) {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return typeof value === 'number' ? value : 0;
  }
  return value === undefined ? null : value;
}

function parseMethodDescriptor(descriptor) {
  const m = /^\((.*)\)(.+)$/.exec(descriptor);
  if (!m) throw new Error(`bad descriptor ${descriptor}`);
  const params = [];
  let s = m[1];
  while (s.length) {
    let dims = 0;
    while (s[dims] === '[') dims++;
    let ch = s[dims];
    let len = dims + 1;
    if (ch === 'L') len = s.indexOf(';', dims) + 1;
    params.push(dims > 0 ? '[' : ch);
    s = s.slice(len);
  }
  return { params, ret: m[2][0] === '[' ? '[' : m[2][0] };
}

function sig(t) {
  switch (t) {
    case T.i32: return 'i';
    case T.i64: return 'l';
    case T.f32: return 'f';
    case T.f64: return 'd';
    default: return 'r';
  }
}

const NPE = (msg) => ({ type: 'java/lang/NullPointerException', message: msg });
const AIOOBE = (i, len) => ({
  type: 'java/lang/ArrayIndexOutOfBoundsException',
  message: `Index ${i} out of bounds for length ${len}`,
});

const BRANCH_COND = {
  if_icmpeq: OP.i32_eq, if_icmpne: OP.i32_ne, if_icmplt: OP.i32_lt_s,
  if_icmpge: OP.i32_ge_s, if_icmpgt: OP.i32_gt_s, if_icmple: OP.i32_le_s,
};
const BRANCH_ZERO = {
  ifeq: OP.i32_eqz, ifne: null, iflt: OP.i32_lt_s,
  ifge: OP.i32_ge_s, ifgt: OP.i32_gt_s, ifle: OP.i32_le_s,
};
const ICONST = {
  iconst_m1: -1, iconst_0: 0, iconst_1: 1, iconst_2: 2,
  iconst_3: 3, iconst_4: 4, iconst_5: 5,
};
const BIN_OPS = {
  iadd: [T.i32, OP.i32_add], isub: [T.i32, OP.i32_sub], imul: [T.i32, OP.i32_mul],
  iand: [T.i32, OP.i32_and], ior: [T.i32, OP.i32_or], ixor: [T.i32, OP.i32_xor],
  ishl: [T.i32, OP.i32_shl], ishr: [T.i32, OP.i32_shr_s], iushr: [T.i32, OP.i32_shr_u],
  ladd: [T.i64, OP.i64_add], lsub: [T.i64, OP.i64_sub], lmul: [T.i64, OP.i64_mul],
  land: [T.i64, OP.i64_and], lor: [T.i64, OP.i64_or], lxor: [T.i64, OP.i64_xor],
  fadd: [T.f32, OP.f32_add], fsub: [T.f32, OP.f32_sub], fmul: [T.f32, OP.f32_mul], fdiv: [T.f32, OP.f32_div],
  dadd: [T.f64, OP.f64_add], dsub: [T.f64, OP.f64_sub], dmul: [T.f64, OP.f64_mul], ddiv: [T.f64, OP.f64_div],
};
const ARRAY_LOAD = {
  iaload: T.i32, baload: T.i32, caload: T.i32, saload: T.i32,
  laload: T.i64, faload: T.f32, daload: T.f64, aaload: T.ref,
};
const ARRAY_STORE = {
  iastore: T.i32, bastore: T.i32, castore: T.i32, sastore: T.i32,
  lastore: T.i64, fastore: T.f32, dastore: T.f64, aastore: T.ref,
};
const MATH_INTRINSICS = new Set([
  'abs', 'max', 'min', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sqrt', 'pow', 'floor', 'ceil', 'log', 'exp',
]);

class Unsupported extends Error {}

const FUEL = 5_000_000;

// Assemble a single-function module exporting `run`. Caller provides the
// import declarations ({name, params, results}), the main signature, local
// declarations (wasm types in index order after params) and the body bytes.
function assembleModule({ importDecls, mainParams, mainResults, declared, body, profilerName }) {
  const typeKey = (p, r) => `${p.join(',')}|${r.join(',')}`;
  const types = [];
  const typeIndex = new Map();
  const internType = (p, r) => {
    const key = typeKey(p, r);
    if (!typeIndex.has(key)) {
      typeIndex.set(key, types.length);
      types.push([0x60, ...uleb(p.length), ...p, ...uleb(r.length), ...r]);
    }
    return typeIndex.get(key);
  };

  const importEntries = [];
  for (const d of importDecls) {
    const ti = internType(d.params, d.results);
    const nameBytes = [...d.name].map((c) => c.charCodeAt(0));
    importEntries.push([3, 0x65, 0x6e, 0x76, ...uleb(nameBytes.length), ...nameBytes, 0x00, ...uleb(ti)]);
  }
  const mainType = internType(mainParams, mainResults);
  const mainIdx = importDecls.length;

  const section = (id, content) => [id, ...uleb(content.length), ...content];
  const vec = (entries) => [...uleb(entries.length), ...entries.flat()];
  const localDecls = [...uleb(declared.length), ...declared.flatMap((t) => [1, t])];
  const funcBody = [...localDecls, ...body];
  const exportName = [...'run'].map((c) => c.charCodeAt(0));
  const profilerNameSection = profilerName
    ? wasmFunctionNameSection(mainIdx, profilerName) : [];

  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec(importEntries)),
    ...section(3, [1, ...uleb(mainType)]),
    ...section(7, [1, exportName.length, ...exportName, 0x00, ...uleb(mainIdx)]),
    ...section(10, [1, ...uleb(funcBody.length), ...funcBody]),
    ...profilerNameSection,
  ]);
}

module.exports = {
  T, CAT2, OP, TRUNC_SAT,
  uleb, sleb, f32bytes, f64bytes,
  wasmProfilerName, wasmFunctionNameSection,
  getOp, descToWasm, toWasmValue, parseMethodDescriptor, sig,
  NPE, AIOOBE,
  BRANCH_COND, BRANCH_ZERO, ICONST, BIN_OPS, ARRAY_LOAD, ARRAY_STORE,
  MATH_INTRINSICS,
  Unsupported,
  FUEL,
  assembleModule,
};
