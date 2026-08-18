'use strict';

// Shared wasm-emission substrate for every wasm tier (the block-dispatcher
// MethodTranslator and the structured backend): type tags, opcode bytes,
// LEB/float encoders, descriptor mapping, boundary value coercion, and the
// module assembler. Pure data/functions — no JVM state.

const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, ref: 0x6f };
const CAT2 = new Set([T.i64, T.f64]);

const OP = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05,
  // Final exception-handling encoding. try_table catch clauses branch to an
  // enclosing label instead of embedding a legacy catch body.
  try_table: 0x1f, catch_all_clause: 0x02, end: 0x0b,
  br: 0x0c, br_if: 0x0d, br_table: 0x0e, return: 0x0f, call: 0x10,
  drop: 0x1a, select: 0x1b,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22,
  global_get: 0x23, global_set: 0x24,
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
  i32_lt_u: 0x49, i32_ge_u: 0x4f,
  i32_load: 0x28, i64_load: 0x29, f32_load: 0x2a, f64_load: 0x2b,
  i32_load8_s: 0x2c, i32_load8_u: 0x2d, i32_load16_s: 0x2e, i32_load16_u: 0x2f,
  i32_store: 0x36, i64_store: 0x37, f32_store: 0x38, f64_store: 0x39,
  i32_store8: 0x3a, i32_store16: 0x3b,
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

// Emit:
//   block $done
//     block $catch
//       try_table (catch_all $catch) { protected body }
//       br $done
//     end
//     handler
//   end
//
// A caught exception branches to $catch's end and enters the handler; normal
// completion skips it. Both callbacks emit void-typed code. The handler runs
// with one enclosing control label, matching the depth formerly occupied by
// the legacy `try`, so branches in existing handler bodies retain their depth.
function emitTryTableCatchAll(out, emitBody, emitCatch) {
  const body = [];
  const handler = [];
  emitBody(body);
  emitCatch(handler);
  out.push(
    OP.block, 0x40,
    OP.block, 0x40,
    OP.try_table, 0x40,
    ...uleb(1), OP.catch_all_clause, ...uleb(0),
    ...body,
    OP.end,
    OP.br, ...uleb(1),
    OP.end,
    ...handler,
    OP.end,
  );
}

let wasmTryTableSupport;
function supportsWasmTryTable() {
  if (wasmTryTableSupport !== undefined) return wasmTryTableSupport;
  if (typeof WebAssembly === 'undefined' ||
      typeof WebAssembly.validate !== 'function') {
    wasmTryTableSupport = false;
    return wasmTryTableSupport;
  }
  const body = [];
  emitTryTableCatchAll(body, () => {}, () => {});
  body.push(OP.end);
  try {
    wasmTryTableSupport = WebAssembly.validate(assembleModule({
      importDecls: [],
      mainParams: [],
      mainResults: [],
      declared: [],
      body,
    }));
  } catch (error) {
    wasmTryTableSupport = false;
  }
  return wasmTryTableSupport;
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
const AIOOBE = (i, len) => {
  if (typeof process !== 'undefined' && process.env &&
      process.env.JVM_DEBUG_ARRAY_OOB === '1') {
    console.error('[array-oob:wasm]', JSON.stringify({ index: i, length: len })
      + '\n' + new Error().stack.split('\n').slice(2, 12)
        .map((line) => line.trim()).join('\n'));
  }
  return {
    type: 'java/lang/ArrayIndexOutOfBoundsException',
    message: `Index ${i} out of bounds for length ${len}`,
  };
};

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

function mathIntrinsicFunction(name, descriptor) {
  const { params, ret } = parseMethodDescriptor(descriptor);
  if (ret === 'J' || params.includes('J')) {
    // WebAssembly i64 imports receive and return BigInt. JavaScript Math
    // rejects BigInt, and converting through Number would lose exact long
    // values. Java Math exposes only these three long overloads.
    if (name === 'abs' && descriptor === '(J)J') {
      return (value) => BigInt.asIntN(64, value < 0n ? -value : value);
    }
    if (name === 'max' && descriptor === '(JJ)J') {
      return (left, right) => left > right ? left : right;
    }
    if (name === 'min' && descriptor === '(JJ)J') {
      return (left, right) => left < right ? left : right;
    }
    return null;
  }
  const jsFn = Math[name];
  if (typeof jsFn !== 'function') return null;
  return ret === 'F'
    ? (...args) => Math.fround(jsFn(...args))
    : (...args) => jsFn(...args);
}

// Control-flow exception (per-block demotion, callee-link deferral, whole-
// method rejection) thrown thousands of times per boot: V8's stack capture in
// the Error constructor was ~1s of a profiled run, so skip it — nothing ever
// reads .stack, only .message.
class Unsupported extends Error {
  // `blockedOn` names what has to change before this refusal could go away:
  // a guest CLASS (absent, or merely uninitialized), or a callee METHOD that
  // does not own a module yet — named as `Class.name(descriptor)`, which the
  // signature tells apart by the '('. Either a single name or an array, for a
  // refusal that waits on any of several (no impl in a cone is ready).
  //
  // It is what makes the demotion recoverable on a schedule rather than on a
  // guess: the entry gate rebuilds the module when exactly those things move,
  // instead of when any part of the world does. Leave it null for permanent
  // refusals (an unsupported opcode, a disabled feature) — those must never
  // trigger a rebuild. But note that a null on a RECOVERABLE refusal is worse
  // than useless: the gate treats a non-empty blocker set as the complete
  // account of what this module lost, so an unnamed recoverable loss becomes
  // invisible rather than merely imprecise.
  constructor(message, blockedOn = null) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super(message);
    Error.stackTraceLimit = limit;
    this.blockedOn = blockedOn;
  }
}

// The names a refusal waits on, as a list — blockedOn may be one or several,
// and is absent on permanent refusals.
function blockedNames(err) {
  if (!err || !err.blockedOn) return [];
  return Array.isArray(err.blockedOn) ? err.blockedOn : [err.blockedOn];
}

// Block transfers allowed per wasm run before the module spills and hands
// back to the interpreter. Overridable for debugging: a fuel exit is the only
// point where a structured module writes its SSA values back to frame.locals,
// so raising it isolates whether a miscompile lives in that spill path.
const FUEL = Number(process.env.JVM_WASM_FUEL || 5_000_000);

// Largest dispatch cone an instance call site will compile a map for. Read per
// call rather than captured, so a test or a boot experiment can move it with
// JVM_WASM_MAX_IMPLS without reloading the module graph.
function maxImpls() {
  return Number(process.env.JVM_WASM_MAX_IMPLS) || 4;
}

// Guest exceptions are plain objects with a string `type` (never Error
// instances); host errors (TypeError, NestedDeopt, ...) are everything else.
// The EH import wrappers use this to decide catch-and-dispatch vs rethrow.
function isGuestThrow(e) {
  return e !== null && typeof e === 'object' &&
    typeof e.type === 'string' && !(e instanceof Error);
}

// Thrown through wasm frames when a linked partial callee reaches one of its
// demoted (diagnostic) blocks: carries the interpreter frames to materialize,
// innermost first. Never visible to guest code — execute() always catches it.
// Lives here (not WasmJit) so StructuredWasmCompiler can catch it without a
// circular require.
class NestedDeopt extends Error {
  constructor(frames) {
    // fired on every partial-callee deopt at steady state: skip V8's stack
    // capture, nothing reads .stack
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super('wasm nested deopt');
    Error.stackTraceLimit = limit;
    this.frames = frames;
  }
}

// Assemble a single-function module exporting `run`. Caller provides the
// import declarations ({name, params, results}), the main signature, local
// declarations (wasm types in index order after params) and the body bytes.
// One mutable zero-initialized global of type t, exported as "retv". Return
// values travel through it instead of a wasm->js ret_* import call: the
// standalone entry and every nested-call bridge read exports.retv.value once
// after run() reports -1, saving a JS boundary crossing per non-void return.
function retvGlobalEntry(t) {
  const zero = t === T.i64 ? [0x42, 0x00]
    : t === T.f32 ? [0x43, 0x00, 0x00, 0x00, 0x00]
      : t === T.f64 ? [0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        : t === T.ref ? [0xd0, 0x6f]
          : [0x41, 0x00];
  return [t, 0x01, ...zero, 0x0b];
}

// Body of the direct-link wrapper: forward the java params, supply entry
// block 0 and the nested-call fuel budget, run the main function, then push
// the retv global so a wasm->wasm caller receives [status, value] without
// any JS boundary. Mirrors the JS bridges' full[] tail exactly.
function runvWrapperBody(paramCount, mainIdx, retvType) {
  const out = [0]; // no locals
  for (let i = 0; i < paramCount; i++) out.push(OP.local_get, ...uleb(i));
  out.push(OP.i32_const, ...sleb(0));
  out.push(OP.i32_const, ...sleb(100_000_000));
  out.push(OP.call, ...uleb(mainIdx));
  if (retvType) out.push(OP.global_get, ...uleb(0));
  out.push(OP.end);
  return out;
}

// Mutable i32 global (init 1) exported as "specok": the world-validity flag
// for speculative monomorphic direct links. The jit zeroes every registered
// instance's flag on each class load; entry/nested revalidation sets it back
// once the module's baked speculations are re-verified. Defined AFTER retv so
// no existing global index shifts.
function specokGlobalEntry() {
  return [T.i32, 0x01, 0x41, 0x01, 0x0b];
}

function assembleModule({ importDecls, mainParams, mainResults, declared, body, profilerName,
  importMemory, retvType, runvWrapper, specokGlobal }) {
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
  if (importMemory) {
    // (import "env" "mem" (memory 1)) — memories index separately from
    // functions, so this does not shift any call target
    importEntries.push([3, 0x65, 0x6e, 0x76, 3, 0x6d, 0x65, 0x6d, 0x02, 0x00, ...uleb(1)]);
  }
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
  const globalEntries = [
    ...(retvType ? [retvGlobalEntry(retvType)] : []),
    ...(specokGlobal ? [specokGlobalEntry()] : []),
  ];
  const globalSection = globalEntries.length
    ? section(6, [globalEntries.length, ...globalEntries.flat()]) : [];
  const retvName = [...'retv'].map((c) => c.charCodeAt(0));
  const specokName = [...'specok'].map((c) => c.charCodeAt(0));
  const specokIdx = retvType ? 1 : 0;
  // The runv wrapper takes the java params only (block 0 / fuel are
  // supplied inside) and returns [status, value] for direct wasm->wasm
  // callers. Only real method modules ask for it: their main signature is
  // (params..., blk, fuel) -> [status].
  const paramOnly = runvWrapper ? mainParams.slice(0, mainParams.length - 2) : [];
  const runvType = runvWrapper
    ? internType(paramOnly, retvType ? [T.i32, retvType] : [T.i32]) : 0;
  const runvBody = runvWrapper
    ? runvWrapperBody(paramOnly.length, mainIdx, retvType) : [];
  const runvName = [...'runv'].map((c) => c.charCodeAt(0));
  const exportEntries = [
    [exportName.length, ...exportName, 0x00, ...uleb(mainIdx)],
    ...(runvWrapper
      ? [[runvName.length, ...runvName, 0x00, ...uleb(mainIdx + 1)]] : []),
    ...(retvType ? [[retvName.length, ...retvName, 0x03, 0]] : []),
    ...(specokGlobal
      ? [[specokName.length, ...specokName, 0x03, ...uleb(specokIdx)]] : []),
  ];
  const functionSection = runvWrapper
    ? [2, ...uleb(mainType), ...uleb(runvType)]
    : [1, ...uleb(mainType)];
  const codeSection = runvWrapper
    ? [2, ...uleb(funcBody.length), ...funcBody,
      ...uleb(runvBody.length), ...runvBody]
    : [1, ...uleb(funcBody.length), ...funcBody];

  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec(importEntries)),
    ...section(3, functionSection),
    ...globalSection,
    ...section(7, vec(exportEntries)),
    ...section(10, codeSection),
    ...profilerNameSection,
  ]);
}

// Ops that may appear in a wrap-and-rethrow reporter handler before its
// terminating athrow. Forward branches are handled separately: obfuscator
// reporters commonly select "null" versus "{...}" while formatting args.
const REPORTER_OPS = /^(astore|aload|iload|lload|fload|dload|ldc|ldc_w|ldc2_w|bipush|sipush|iconst|lconst|fconst|dconst|aconst_null|new|dup|checkcast|getstatic|invokespecial|invokevirtual|invokestatic|invokedynamic|i2l|i2c|l2i)/;

function isNoOpExceptionHandler(codeItems, handlerIndex, labelIndex) {
  let furthestForwardTarget = handlerIndex;
  // Large game methods can have reporters that append dozens of arguments.
  // Keep discovery bounded, but do not confuse their size with recovery.
  const end = Math.min(codeItems.length, handlerIndex + 512);
  for (let i = handlerIndex; i < end; i++) {
    const instruction = codeItems[i] && codeItems[i].instruction;
    const op = getOp(instruction);
    if (!op) continue;
    if (op === 'athrow') {
      // Obfuscators commonly leave an unreachable throw on one side of a
      // forward null-selection branch. It is not the handler terminator when
      // another branch target still has to be visited.
      if (i >= furthestForwardTarget) return true;
      continue;
    }
    if (op === 'goto' || op.startsWith('if')) {
      const target = instruction && typeof instruction === 'object'
        ? labelIndex.get(instruction.arg) : undefined;
      // Backedges can run arbitrary recovery logic; unresolved targets are
      // not a proof either.
      if (target === undefined || target <= i) return false;
      furthestForwardTarget = Math.max(furthestForwardTarget, target);
      continue;
    }
    if (/^(return|[a-z]return|putfield|putstatic|[a-z]astore|monitorenter|monitorexit)$/.test(op)) {
      return false;
    }
    if (!REPORTER_OPS.test(op)) return false;
  }
  return false;
}

function catchesOnlyCheckedExceptions(jvm, catchType) {
  if (!catchType || catchType === 'any') return false;

  // Every operation emitted by the wasm tiers is either non-throwing or can
  // only raise an unchecked VM exception (null/bounds/arithmetic). Calls
  // capable of throwing a declared checked exception remain exit stubs and
  // execute in the interpreter at their precise bytecode pc. Therefore a
  // handler for a checked-exception subtype cannot observe a failure from a
  // compiled block. Require a resolved hierarchy on both sides: broad
  // Exception/Throwable handlers and unknown application exception types
  // stay conservative.
  return jvm.isInstanceOf(catchType, 'java/lang/Exception') &&
    !jvm.isInstanceOf(catchType, 'java/lang/RuntimeException') &&
    !jvm.isInstanceOf('java/lang/RuntimeException', catchType);
}

// Returns the item-index ranges [start, end) protected by LIVE (non-no-op)
// handlers. Blocks intersecting these ranges must stay interpreted. No-op
// handler entries (bare rethrow, wrap-and-rethrow reporter) contribute none.
function liveExceptionRanges(jvm, code, labelIndex) {
  const table = code.exceptionTable || [];
  const ranges = [];
  for (const entry of table) {
    const label = entry.handlerLbl || `L${entry.handler_pc}`;
    const h = labelIndex.get(label);
    const live = h === undefined || !isNoOpExceptionHandler(code.codeItems, h, labelIndex);
    if (live && !catchesOnlyCheckedExceptions(jvm, entry.catch_type)) {
      const s = labelIndex.get(entry.startLbl || `L${entry.start_pc}`);
      const e = labelIndex.get(entry.endLbl || `L${entry.end_pc}`);
      // an unresolvable range must poison the whole method, not vanish
      ranges.push([s === undefined ? 0 : s, e === undefined ? code.codeItems.length : e]);
    }
  }
  return ranges;
}

module.exports = {
  T, CAT2, OP, TRUNC_SAT,
  uleb, sleb, f32bytes, f64bytes,
  emitTryTableCatchAll, supportsWasmTryTable,
  wasmProfilerName, wasmFunctionNameSection,
  getOp, descToWasm, toWasmValue, parseMethodDescriptor, sig,
  NPE, AIOOBE,
  BRANCH_COND, BRANCH_ZERO, ICONST, BIN_OPS, ARRAY_LOAD, ARRAY_STORE,
  MATH_INTRINSICS,
  mathIntrinsicFunction,
  Unsupported,
  blockedNames,
  NestedDeopt,
  maxImpls,
  isGuestThrow,
  specokGlobalEntry,
  FUEL,
  assembleModule, retvGlobalEntry, runvWrapperBody,
  isNoOpExceptionHandler, catchesOnlyCheckedExceptions, liveExceptionRanges,
};
