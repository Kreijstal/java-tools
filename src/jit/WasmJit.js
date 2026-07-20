'use strict';

// WASM tier for hot numeric methods.
//
// Translates the numeric/array/field subset of Java bytecode into a
// WebAssembly module emitted directly as binary (no toolchain). Control flow
// is the switch-loop dispatcher: every basic block is a br_table target, so
// goto-style bytecode needs no structuring pass, and the block index doubles
// as an on-stack-replacement entry point.
//
// Eligibility is per BASIC BLOCK, not per method: a block containing an
// unsupported opcode (invokes, allocation, monitors, switches, ...) becomes
// an "exit stub" that spills the wasm locals back into frame.locals and
// returns the block's first item index; the caller sets frame.pc and the
// interpreter resumes there. That lets a method like jn.b()V — a hot mixing
// loop followed by a single SourceDataLine.write call — run its loop in wasm
// and only the tail interpreted.
//
// Operand-stack values may cross block boundaries: a pre-pass infers each
// block's entry stack shape (types) by propagating along CFG edges from the
// method entry — verifier-valid bytecode has a unique shape per merge point.
// Carried values travel in dedicated per-(depth,type) wasm locals: a
// transfer stores the live stack into them and the target block's prologue
// reloads. Blocks whose inferred entry stack is non-empty can only be
// reached through compiled predecessors — external entry (call, OSR probe,
// resume) is restricted to blocks with an empty entry shape AND an empty
// frame.stack. When a block with carried entry values is demoted, its exit
// stub also pushes those values into frame.stack so the interpreter resumes
// with the true operand stack.
//
// Heap access stays in JS: array element ops, arraylength and field access
// are imported functions that replicate the interpreter's exact semantics
// (including its bounds-check and `.elements` behavior), so results are
// bit-identical to interpretation. Longs are native i64 (BigInt only at the
// call boundary); Java floats are f32, matching the interpreter's
// Math.fround semantics.
//
// A fuel parameter bounds how many block transfers a single wasm run may
// make, so a compiled spin-loop cannot starve the cooperative green-thread
// scheduler: on exhaustion the method exits transiently at the current block
// and re-enters on a later tick.
//
// Exception tables: handlers that are semantic no-ops are ignored. Two
// obfuscator shapes qualify: a bare `athrow` at the handler pc
// (catch-and-rethrow — identical semantics), and the wrap-and-rethrow
// reporter (astore, StringBuilder site-signature append, wrapper invoke,
// athrow — no branches, no recovery). Handlers that recover, retry or
// return are "live": every block intersecting a live handler's try-range is
// demoted, so anything that can throw inside such a range runs interpreted
// with correct pc/locals for the catch. Compiled blocks always lie outside
// live ranges, and a throw escaping wasm surfaces at the (stale) entry pc —
// also outside live ranges, since external entry is limited to supported
// blocks — so a live handler can never match on stale state; only the no-op
// shapes can, and those behave identically (modulo the wrapper's site
// string).
//
// invokestatic sites can bind directly to other fully-compiled wasm
// methods, so e.g. va.d's table-generation loops stay in wasm across their
// va.b/va.c helper calls. Methods whose invoke blocks were demoted are
// recompiled after an exit storm to pick up callees that became ready
// later. Synchronized methods compile too: this green-thread interpreter
// implements no implicit method monitor (only explicit monitorenter/exit
// opcodes), and wasm replicates interpreter semantics, not the JLS.

const { resolveInstanceFieldKey } = require('../instructions/object');

const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, ref: 0x6f };
const CAT2 = new Set([T.i64, T.f64]);

const OP = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b,
  br: 0x0c, br_if: 0x0d, br_table: 0x0e, return: 0x0f, call: 0x10,
  drop: 0x1a,
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

// Returns the item-index ranges [start, end) protected by LIVE (non-no-op)
// handlers. Blocks intersecting these ranges must stay interpreted. No-op
// handler entries (bare rethrow, wrap-and-rethrow reporter) contribute none.
function catchesOnlyCheckedExceptions(jvm, catchType) {
  if (!catchType || catchType === 'any') return false;

  // Every operation emitted by this tier is either non-throwing or can only
  // raise an unchecked VM exception (null/bounds/arithmetic). Calls capable
  // of throwing a declared checked exception remain exit stubs and execute in
  // the interpreter at their precise bytecode pc. Therefore a handler for a
  // checked-exception subtype cannot observe a failure from a compiled block.
  // Require a resolved hierarchy on both sides: broad Exception/Throwable
  // handlers and unknown application exception types stay conservative.
  return jvm.isInstanceOf(catchType, 'java/lang/Exception') &&
    !jvm.isInstanceOf(catchType, 'java/lang/RuntimeException') &&
    !jvm.isInstanceOf('java/lang/RuntimeException', catchType);
}

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

class MethodTranslator {
  constructor(jvm, method, className, wasmJit) {
    this.jvm = jvm;
    this.method = method;
    this.className = className;
    this.wasmJit = wasmJit;
    const codeAttr = method.attributes.find((a) => a.type === 'code');
    this.items = codeAttr.code.codeItems;
    this.desc = parseMethodDescriptor(method.descriptor);
    this.isStatic = (method.flags || []).includes('static');

    this.labelIndex = new Map();
    this.items.forEach((it, i) => {
      if (it.labelDef) this.labelIndex.set(it.labelDef.slice(0, -1), i);
    });

    this.importFns = [];        // JS functions in index order
    this.importDecls = [];      // {name, params:[wasmtype], results:[wasmtype]}
    this.importIndexByName = new Map();
    this.box = { frame: null, ret: undefined };
    this.demoteReasons = new Map();
  }

  targetOf(ins) {
    const idx = this.labelIndex.get(ins.arg);
    if (idx === undefined) throw new Unsupported(`unknown label ${ins.arg}`);
    return idx;
  }

  // ---- import registry ----
  addImport(name, params, results, fn) {
    if (this.importIndexByName.has(name)) return this.importIndexByName.get(name);
    const idx = this.importDecls.length;
    this.importDecls.push({ name, params, results });
    this.importFns.push(fn);
    this.importIndexByName.set(name, idx);
    return idx;
  }

  elemsOf(a, i, opName) {
    // bug-compatible with instructions/utils.js: bounds use arrayRef.length
    if (a === null || a === undefined) throw NPE(`Attempted ${opName} on null array in ${this.method.name}`);
    if (i < 0 || i >= a.length) throw AIOOBE(i, a.length);
    return a;
  }

  arrayImports() {
    const self = this;
    const mk = (suffix, t) => {
      self.addImport(`aget_${suffix}`, [T.ref, T.i32], [t], (a, i) => {
        const arr = self.elemsOf(a, i, 'load');
        return toWasmValue(t, arr.elements ? arr.elements[i] : arr[i]);
      });
      self.addImport(`aset_${suffix}`, [T.ref, T.i32, t], [], (a, i, v) => {
        self.elemsOf(a, i, 'store')[i] = v;
      });
    };
    mk('i', T.i32); mk('l', T.i64); mk('f', T.f32); mk('d', T.f64); mk('r', T.ref);
    self.addImport('alen', [T.ref], [T.i32], (a) => {
      if (a === null || a === undefined) throw NPE(`Attempted to get length of null array in ${self.method.name}`);
      return a.length;
    });
  }

  runtimeImports() {
    const box = this.box;
    this.addImport('spill_i', [T.i32, T.i32], [], (s, v) => { box.frame.locals[s] = v; });
    this.addImport('spill_l', [T.i32, T.i64], [], (s, v) => { box.frame.locals[s] = v; });
    this.addImport('spill_f', [T.i32, T.f32], [], (s, v) => { box.frame.locals[s] = v; });
    this.addImport('spill_d', [T.i32, T.f64], [], (s, v) => { box.frame.locals[s] = v; });
    this.addImport('spill_r', [T.i32, T.ref], [], (s, v) => { box.frame.locals[s] = v; });
    // push a carried operand-stack value into frame.stack on transient exit
    this.addImport('push_i', [T.i32], [], (v) => { box.frame.stack.push(v); });
    this.addImport('push_l', [T.i64], [], (v) => { box.frame.stack.push(v); });
    this.addImport('push_f', [T.f32], [], (v) => { box.frame.stack.push(Math.fround(v)); });
    this.addImport('push_d', [T.f64], [], (v) => { box.frame.stack.push(v); });
    this.addImport('push_r', [T.ref], [], (v) => { box.frame.stack.push(v); });
    this.addImport('ref_eq', [T.ref, T.ref], [T.i32], (a, b) => a === b ? 1 : 0);
    this.addImport('ret_i', [T.i32], [], (v) => { box.ret = v; });
    this.addImport('ret_l', [T.i64], [], (v) => { box.ret = v; });
    this.addImport('ret_f', [T.f32], [], (v) => { box.ret = Math.fround(v); });
    this.addImport('ret_d', [T.f64], [], (v) => { box.ret = v; });
    this.addImport('ret_r', [T.ref], [], (v) => { box.ret = v; });
    this.addImport('err_div0', [], [], () => {
      throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
    });
  }

  spillImportFor(t) {
    switch (t) {
      case T.i32: return this.importIndexByName.get('spill_i');
      case T.i64: return this.importIndexByName.get('spill_l');
      case T.f32: return this.importIndexByName.get('spill_f');
      case T.f64: return this.importIndexByName.get('spill_d');
      default: return this.importIndexByName.get('spill_r');
    }
  }

  pushImportFor(t) {
    switch (t) {
      case T.i32: return this.importIndexByName.get('push_i');
      case T.i64: return this.importIndexByName.get('push_l');
      case T.f32: return this.importIndexByName.get('push_f');
      case T.f64: return this.importIndexByName.get('push_d');
      default: return this.importIndexByName.get('push_r');
    }
  }

  // Dedicated wasm local carrying operand-stack depth d of type t across
  // block boundaries. Allocation is stable across pass 2 and exit stubs.
  stackLocalFor(d, t) {
    const key = `${d}|${t}`;
    let idx = this.stackLocals.get(key);
    if (idx === undefined) {
      idx = this.nextLocal++;
      this.declared.push(t);
      this.stackLocals.set(key, idx);
    }
    return idx;
  }

  // store the simulated stack (types bottom-up) into carry locals, top first
  storeCarrySeq(types) {
    const seq = [];
    for (let d = types.length - 1; d >= 0; d--) {
      seq.push(OP.local_set, ...uleb(this.stackLocalFor(d, types[d])));
    }
    return seq;
  }

  // reload carry locals onto the wasm stack, bottom-up
  loadCarrySeq(types) {
    const seq = [];
    for (let d = 0; d < types.length; d++) {
      seq.push(OP.local_get, ...uleb(this.stackLocalFor(d, types[d])));
    }
    return seq;
  }

  // push carried entry values into frame.stack (bottom-up) for an exit
  pushCarrySeq(types) {
    const seq = [];
    for (let d = 0; d < types.length; d++) {
      seq.push(OP.local_get, ...uleb(this.stackLocalFor(d, types[d])),
        OP.call, ...uleb(this.pushImportFor(types[d])));
    }
    return seq;
  }

  // CFG edge with the given stack shape: pass 1 records the target's entry
  // shape; pass 2 verifies the recorded shape matches (demoting the source
  // block on mismatch — only paths through already-demoted blocks disagree).
  edgeShape(targetBlk, types) {
    const known = this.entryStacks.get(targetBlk);
    if (known === undefined) {
      this.entryStacks.set(targetBlk, types.slice());
      return;
    }
    if (!this.dryRun &&
        (known.length !== types.length || known.some((t, i) => t !== types[i]))) {
      throw new Unsupported('stack shape mismatch at edge');
    }
  }

  fieldImports(ins, isStaticOp, isGet) {
    const [, className, [fieldName, descriptor]] = ins.arg;
    const t = descToWasm(descriptor[0]);
    const jvm = this.jvm;
    if (isStaticOp) {
      // Resolve eagerly at compile time — if the owning class is not loaded
      // and initialized yet, the block is demoted rather than risking a
      // skipped <clinit> at run time.
      let currentClassName = className;
      let container = null;
      let key = null;
      while (currentClassName) {
        const cd = jvm.classes[currentClassName];
        if (cd && cd.staticFields) {
          const fieldKey = `${fieldName}:${descriptor}`;
          if (cd.staticFields.has(fieldKey)) { container = cd.staticFields; key = fieldKey; break; }
          if (cd.staticFields.has(fieldName)) { container = cd.staticFields; key = fieldName; break; }
        }
        currentClassName = cd && cd.ast && cd.ast.classes[0] ? cd.ast.classes[0].superClassName : null;
      }
      if (!container) throw new Unsupported(`unresolved static ${className}.${fieldName}`);
      const name = `${isGet ? 'gs' : 'ps'}_${className}_${fieldName}`.replace(/[^\w]/g, '_');
      return {
        t,
        idx: isGet
          ? this.addImport(name, [], [t], () => toWasmValue(t, container.get(key)))
          : this.addImport(name, [t], [], (v) => container.set(key, v)),
      };
    }
    const name = `${isGet ? 'gf' : 'pf'}_${className}_${fieldName}`.replace(/[^\w]/g, '_');
    const keyCache = new Map();
    const resolveKey = (obj) => {
      const ct = obj._className || obj.type;
      let key = keyCache.get(ct);
      if (key === undefined) {
        key = resolveInstanceFieldKey(jvm, obj, className, fieldName) || `${className}.${fieldName}`;
        keyCache.set(ct, key);
      }
      return key;
    };
    return {
      t,
      idx: isGet
        ? this.addImport(name, [T.ref], [t], (obj) => {
          if (obj === null || obj === undefined) {
            throw { type: 'java/lang/NullPointerException', message: null };
          }
          return toWasmValue(t, obj.fields[resolveKey(obj)]);
        })
        : this.addImport(name, [T.ref, t], [], (obj, v) => {
          if (obj === null || obj === undefined) {
            throw { type: 'java/lang/NullPointerException', message: null };
          }
          obj.fields[resolveKey(obj)] = v;
        }),
    };
  }

  mathIntrinsic(ins) {
    const [, className, [name, descriptor]] = ins.arg;
    if (className !== 'java/lang/Math' || !MATH_INTRINSICS.has(name)) {
      throw new Unsupported(`invoke ${className}.${name}`);
    }
    const { params, ret } = parseMethodDescriptor(descriptor);
    if (![...params, ret].every((c) => 'IJFD'.includes(c))) {
      throw new Unsupported(`Math.${name}${descriptor} non-numeric`);
    }
    const wParams = params.map(descToWasm);
    const wRet = descToWasm(ret);
    const jsFn = Math[name];
    const fn = ret === 'F'
      ? (...args) => Math.fround(jsFn(...args))
      : (...args) => jsFn(...args);
    return {
      params: wParams,
      ret: wRet,
      idx: this.addImport(`math_${name}_${descriptor}`.replace(/[^\w]/g, '_'), wParams, [wRet], fn),
    };
  }

  // invokestatic bound directly to another fully-compiled wasm method
  compiledCallee(ins) {
    const [, className, [name, descriptor]] = ins.arg;
    const { params, ret } = parseMethodDescriptor(descriptor);
    if (![...params, ret].every((c) => 'IJFDZBCSV[L'.includes(c))) {
      throw new Unsupported(`invoke ${className}.${name} unsupported descriptor`);
    }
    const calleeSt = this.wasmJit && this.wasmJit.findReadyStatic(className, name, descriptor);
    if (!calleeSt || !calleeSt.meta.fullyCompiled || calleeSt.meta.boxedCount) {
      throw new Unsupported(`invoke ${className}.${name}`);
    }
    // java arg slot -> position in the wasm arg list
    const argPosBySlot = new Map();
    let slot = 0;
    params.forEach((p, i) => { argPosBySlot.set(slot, i); slot += (p === 'J' || p === 'D') ? 2 : 1; });
    const wParams = params.map(descToWasm);
    const results = ret === 'V' ? [] : [descToWasm(ret)];
    const key = `${className}.${name}${descriptor}`;
    const fn = (...args) => {
      const meta = calleeSt.meta;
      const full = new Array(meta.paramSlots.length + 2);
      for (let i = 0; i < meta.paramSlots.length; i++) {
        const p = meta.paramSlots[i];
        const pos = argPosBySlot.get(p.slot);
        if (pos !== undefined) full[i] = args[pos];
        else full[i] = p.t === T.i64 ? 0n : (p.t === T.ref ? null : 0);
      }
      full[meta.paramSlots.length] = 0;
      full[meta.paramSlots.length + 1] = 100_000_000;
      const savedFrame = meta.box.frame;
      meta.box.frame = { locals: [] }; // junk sink should a fuel exit ever spill
      meta.box.ret = undefined;
      let status;
      try {
        status = calleeSt.run(...full);
      } finally {
        meta.box.frame = savedFrame;
      }
      if (status !== -1) throw new Error(`wasmjit: nested callee ${key} exited at ${status}`);
      return meta.box.ret;
    };
    return {
      params: wParams,
      idx: this.addImport(`call_${key}`.replace(/[^\w]/g, '_'), wParams, results, fn),
    };
  }

  // ---- per-slot typing (from load/store usage in the whole method) ----
  inferSlotTypes() {
    const slots = new Map();
    const conflicted = new Set();
    let slot = 0;
    if (!this.isStatic) slots.set(slot++, T.ref);
    for (const p of this.desc.params) {
      slots.set(slot, descToWasm(p));
      slot += (p === 'J' || p === 'D') ? 2 : 1;
    }
    const claim = (s, t) => {
      const prev = slots.get(s);
      if (prev !== undefined && prev !== t) conflicted.add(s);
      else slots.set(s, t);
    };
    for (const item of this.items) {
      if (!item.instruction) continue;
      const op = getOp(item.instruction);
      let m;
      if ((m = /^([ilfda])(?:load|store)(?:_(\d))?$/.exec(op))) {
        const s = m[2] !== undefined ? Number(m[2]) : Number(item.instruction.arg);
        claim(s, { i: T.i32, l: T.i64, f: T.f32, d: T.f64, a: T.ref }[m[1]]);
      } else if (op === 'iinc') {
        claim(Number(item.instruction.varnum), T.i32);
      }
    }
    // Slots reused with different types across disjoint lifetimes stay in
    // frame.locals and are accessed through lget/lset imports — always
    // current, so exit stubs need not (and must not) spill them.
    this.boxedSlots = conflicted;
    for (const s of conflicted) slots.delete(s);
    this.slotTypes = slots;
  }

  boxedAccess(slot, t, isStore) {
    const box = this.box;
    const name = `${isStore ? 'lset' : 'lget'}_${sig(t)}`;
    if (isStore) {
      return this.addImport(name, [T.i32, t], [], (s, v) => { box.frame.locals[s] = v; });
    }
    return this.addImport(name, [T.i32], [t], (s) => {
      const v = box.frame.locals[s];
      return toWasmValue(t, v);
    });
  }

  translate() {
    const codeAttr = this.method.attributes.find((a) => a.type === 'code');
    const liveRanges = liveExceptionRanges(this.jvm, codeAttr.code, this.labelIndex);
    this.inferSlotTypes();
    this.runtimeImports();
    this.arrayImports();

    // basic blocks
    const leaders = new Set([0]);
    this.items.forEach((it, i) => {
      if (!it.instruction) return;
      const op = getOp(it.instruction);
      if (op === 'goto' || op === 'goto_w' || BRANCH_COND[op] || op in BRANCH_ZERO ||
          op === 'ifnull' || op === 'ifnonnull' || op === 'if_acmpeq' || op === 'if_acmpne') {
        if (this.labelIndex.has(it.instruction.arg)) leaders.add(this.targetOf(it.instruction));
        if (i + 1 < this.items.length) leaders.add(i + 1);
      }
    });
    this.blockStarts = [...leaders].sort((a, b) => a - b);
    const N = this.blockStarts.length;
    this.blockOfItem = new Map();
    this.blockStarts.forEach((s, b) => this.blockOfItem.set(s, b));

    // wasm locals: params = typed slots in slot order, then blk/fuel params,
    // then declared scratch locals
    this.paramSlots = [...this.slotTypes.keys()].sort((a, b) => a - b);
    this.localOfSlot = new Map();
    this.paramSlots.forEach((s, i) => this.localOfSlot.set(s, i));
    this.blkLocal = this.paramSlots.length;
    this.fuelLocal = this.paramSlots.length + 1;
    this.declared = [];
    this.nextLocal = this.paramSlots.length + 2;
    this.scratchPool = new Map(); // wasm type -> [localIdx]
    this.stackLocals = new Map(); // `${depth}|${type}` -> localIdx

    // blocks intersecting a live handler's try-range must stay interpreted
    const rangeDemoted = new Set();
    for (const [rs, re] of liveRanges) {
      for (let b = 0; b < N; b++) {
        const from = this.blockStarts[b];
        const to = b + 1 < N ? this.blockStarts[b + 1] : this.items.length;
        if (from < re && to > rs) rangeDemoted.add(b);
      }
    }

    // pass 1 (dry run): fix each block's entry stack shape by propagating
    // along CFG edges from the method entry; blocks unreached by propagation
    // (dead code, handler-only targets) are assumed empty. Emitted code and
    // local allocations from this pass are discarded.
    this.entryStacks = new Map([[0, []]]);
    this.dryRun = true;
    {
      const savedNextLocal = this.nextLocal;
      const savedDeclaredLen = this.declared.length;
      const processed = new Set();
      while (processed.size < N) {
        let b = -1;
        for (let i = 0; i < N; i++) {
          if (!processed.has(i) && this.entryStacks.has(i)) { b = i; break; }
        }
        if (b < 0) {
          for (let i = 0; i < N; i++) if (!processed.has(i)) { b = i; break; }
          this.entryStacks.set(b, []);
        }
        processed.add(b);
        try { this.compileBlock(b, N); } catch (err) {
          if (!(err instanceof Unsupported)) throw err;
        }
      }
      this.nextLocal = savedNextLocal;
      this.declared.length = savedDeclaredLen;
      this.scratchPool = new Map();
      this.stackLocals = new Map();
    }
    this.dryRun = false;

    // pass 2: compile each block against the fixed entry shapes;
    // failures demote to exit stubs
    const blockBodies = [];
    this.supportedBlocks = new Set();
    for (let b = 0; b < N; b++) {
      if (rangeDemoted.has(b)) {
        this.demoteReasons.set(b, 'live handler range');
        blockBodies[b] = this.exitStub(b);
        continue;
      }
      try {
        blockBodies[b] = this.compileBlock(b, N);
        this.supportedBlocks.add(b);
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
        this.demoteReasons.set(b, err.message);
        blockBodies[b] = this.exitStub(b);
      }
    }
    if (!this.supportedBlocks.size) throw new Unsupported('no supported blocks');
    this.normalFlowFullyCompiled = [...this.normalReachableBlocks(N)]
      .every((b) => this.supportedBlocks.has(b));

    // external entry (invocation, OSR, resume-after-exit) is only sound at a
    // supported block whose inferred entry stack is empty
    this.externalEntry = new Set(
      [...this.supportedBlocks].filter((b) => (this.entryStacks.get(b) || []).length === 0));
    if (!this.externalEntry.size) throw new Unsupported('no supported blocks');

    // function body: dispatcher loop (fuel is checked per block prologue)
    const body = [];
    body.push(OP.loop, 0x40);
    for (let i = 0; i < N; i++) body.push(OP.block, 0x40);
    body.push(OP.local_get, ...uleb(this.blkLocal));
    body.push(OP.br_table, ...uleb(N));
    for (let i = 0; i < N; i++) body.push(...uleb(i));
    body.push(...uleb(N - 1));
    for (let b = 0; b < N; b++) {
      body.push(OP.end);
      body.push(...blockBodies[b]);
    }
    body.push(OP.end);          // loop
    body.push(OP.unreachable);  // all paths return explicitly
    body.push(OP.end);          // function

    return this.assemble(body);
  }

  normalReachableBlocks(N) {
    const reachable = new Set();
    const pending = [0];
    const blockForTarget = (instruction) => {
      if (!instruction || typeof instruction !== 'object') return undefined;
      const item = this.labelIndex.get(instruction.arg);
      return item === undefined ? undefined : this.blockOfItem.get(item);
    };
    while (pending.length) {
      const b = pending.pop();
      if (b < 0 || b >= N || reachable.has(b)) continue;
      reachable.add(b);
      const from = this.blockStarts[b];
      const to = b + 1 < N ? this.blockStarts[b + 1] : this.items.length;
      let instruction = null;
      for (let i = to - 1; i >= from; i--) {
        if (this.items[i] && this.items[i].instruction) {
          instruction = this.items[i].instruction;
          break;
        }
      }
      const op = getOp(instruction);
      if (op === 'goto' || op === 'goto_w') {
        const target = blockForTarget(instruction);
        if (target !== undefined) pending.push(target);
        continue;
      }
      if (op && (op.startsWith('if'))) {
        const target = blockForTarget(instruction);
        if (target !== undefined) pending.push(target);
        if (b + 1 < N) pending.push(b + 1);
        continue;
      }
      if (op === 'athrow' || op === 'return' || /^[a-z]return$/.test(op || '')) continue;
      if (b + 1 < N) pending.push(b + 1);
    }
    return reachable;
  }

  // maps the value on the stack (block index) to its item index via a chain of
  // selects would be large; instead exit stubs embed constants, and the fuel
  // path needs a runtime mapping — emit a small br_table-free lookup: since
  // fuel exits are rare, use nested selects via multiply-free approach is
  // overkill; simplest correct: a sequence of compares. N is small (<200).
  blockIdxToItemIdxSeq(N) {
    // stack: [blk:i32] -> [itemIdx:i32]
    const t = this.scratch(T.i32);
    const seq = [OP.local_set, ...uleb(t), OP.i32_const, ...sleb(this.blockStarts[0])];
    for (let b = 1; b < N; b++) {
      seq.push(OP.i32_const, ...sleb(this.blockStarts[b]));
      seq.push(OP.local_get, ...uleb(t), OP.i32_const, ...sleb(b), OP.i32_eq);
      seq.push(0x1b); // select
    }
    return seq;
  }

  scratch(t) {
    const pool = this.scratchPool.get(t) || [];
    this.scratchPool.set(t, pool);
    // one scratch per (type, depth-of-use) is overkill; allocate fresh per request
    const idx = this.nextLocal++;
    this.declared.push(t);
    pool.push(idx);
    return idx;
  }

  spillSeq() {
    const seq = [];
    for (const s of this.paramSlots) {
      const t = this.slotTypes.get(s);
      seq.push(OP.i32_const, ...sleb(s), OP.local_get, ...uleb(this.localOfSlot.get(s)),
        OP.call, ...uleb(this.spillImportFor(t)));
    }
    return seq;
  }

  exitStub(blockIndex) {
    const entry = this.entryStacks.get(blockIndex) || [];
    return [
      ...this.spillSeq(),
      ...this.pushCarrySeq(entry),
      OP.i32_const, ...sleb(this.blockStarts[blockIndex]), OP.return,
    ];
  }

  compileBlock(b, N) {
    const from = this.blockStarts[b];
    const to = b + 1 < N ? this.blockStarts[b + 1] : this.items.length;
    const depthToTop = N - 1 - b;
    const code = [];
    const stack = (this.entryStacks.get(b) || []).slice(); // wasm types, bottom-up
    const emit = (...bytes) => code.push(...bytes);
    const push = (t) => stack.push(t);
    const pop = (expected) => {
      if (!stack.length) throw new Unsupported('stack underflow (value flows across block boundary)');
      const t = stack.pop();
      if (expected !== undefined && t !== expected) throw new Unsupported(`stack type mismatch`);
      return t;
    };
    const jump = (targetBlk, extraDepth, carryStored = false) => {
      this.edgeShape(targetBlk, stack);
      if (!carryStored) emit(...this.storeCarrySeq(stack));
      emit(OP.i32_const, ...sleb(targetBlk), OP.local_set, ...uleb(this.blkLocal),
        OP.br, ...uleb(depthToTop + extraDepth));
    };
    const condBranch = (ins) => {
      const target = this.blockOfTarget(this.targetOf(ins));
      const fallthrough = this.blockOfItem.get(to);
      if (fallthrough === undefined) throw new Unsupported('conditional without fallthrough block');
      const condition = this.scratch(T.i32);
      // The branch condition sits above any values carried to both successors.
      // Save it, move the carried values into locals, and reload those values
      // after the not-taken arm so the ordinary fallthrough transfer can store
      // them in exactly the same way as an unconditional edge.
      emit(OP.local_set, ...uleb(condition), ...this.storeCarrySeq(stack));
      this.edgeShape(fallthrough, stack);
      emit(OP.local_get, ...uleb(condition));
      emit(OP.if, 0x40);
      jump(target, 1, true);
      emit(OP.end);
      emit(...this.loadCarrySeq(stack));
    };
    const localOf = (s) => {
      const l = this.localOfSlot.get(s);
      if (l === undefined) throw new Unsupported(`untyped slot ${s}`);
      return l;
    };
    const guardedDiv = (t, divOp, isRem) => {
      const ib = this.scratch(t); const ia = this.scratch(t);
      const one = t === T.i64 ? [OP.i64_const, ...sleb(-1n)] : [OP.i32_const, ...sleb(-1)];
      const eqz = t === T.i64 ? OP.i64_eqz : OP.i32_eqz;
      const eq = t === T.i64 ? OP.i64_eq : OP.i32_eq;
      emit(OP.local_set, ...uleb(ib), OP.local_set, ...uleb(ia));
      emit(OP.local_get, ...uleb(ib), eqz, OP.if, 0x40,
        OP.call, ...uleb(this.importIndexByName.get('err_div0')), OP.unreachable, OP.end);
      if (isRem) {
        emit(OP.local_get, ...uleb(ia), OP.local_get, ...uleb(ib), divOp);
      } else {
        // MIN_VALUE / -1 wraps in Java but traps in wasm
        emit(OP.local_get, ...uleb(ib), ...one, eq, OP.if, t);
        const zero = t === T.i64 ? [OP.i64_const, ...sleb(0n)] : [OP.i32_const, ...sleb(0)];
        emit(...zero, OP.local_get, ...uleb(ia), t === T.i64 ? OP.i64_sub : OP.i32_sub);
        emit(OP.else, OP.local_get, ...uleb(ia), OP.local_get, ...uleb(ib), divOp, OP.end);
      }
      pop(); pop(); push(t);
    };
    const fcmp = (t, nanVal) => {
      const sb = this.scratch(t); const sa = this.scratch(t);
      const [gt, lt, eq] = t === T.f32
        ? [OP.f32_gt, OP.f32_lt, OP.f32_eq] : [OP.f64_gt, OP.f64_lt, OP.f64_eq];
      emit(OP.local_set, ...uleb(sb), OP.local_set, ...uleb(sa));
      const cmp = (op) => [OP.local_get, ...uleb(sa), OP.local_get, ...uleb(sb), op];
      emit(...cmp(gt), OP.if, T.i32, OP.i32_const, ...sleb(1), OP.else);
      emit(...cmp(lt), OP.if, T.i32, OP.i32_const, ...sleb(-1), OP.else);
      emit(...cmp(eq), OP.if, T.i32, OP.i32_const, ...sleb(0),
        OP.else, OP.i32_const, ...sleb(nanVal), OP.end);
      emit(OP.end, OP.end);
      pop(); pop(); push(T.i32);
    };

    // Charge fuel per basic block. Carry locals already contain this block's
    // entry stack, so a fuel exit can materialize the interpreter frame before
    // the values are reloaded onto the wasm operand stack.
    emit(OP.local_get, ...uleb(this.fuelLocal), OP.i32_const, ...sleb(1), OP.i32_sub,
      OP.local_tee, ...uleb(this.fuelLocal), OP.i32_eqz, OP.if, 0x40,
      ...this.exitStub(b), OP.end,
      ...this.loadCarrySeq(stack));

    for (let i = from; i < to; i++) {
      const ins = this.items[i].instruction;
      if (!ins) continue;
      const op = getOp(ins);
      const localArg = () => {
        const m = /_(\d)$/.exec(op);
        return Number(m ? m[1] : ins.arg);
      };

      if (op in ICONST) { emit(OP.i32_const, ...sleb(ICONST[op])); push(T.i32); }
      else if (op === 'lconst_0' || op === 'lconst_1') {
        emit(OP.i64_const, ...sleb(op === 'lconst_1' ? 1n : 0n)); push(T.i64);
      } else if (op === 'fconst_0' || op === 'fconst_1' || op === 'fconst_2') {
        emit(OP.f32_const, ...f32bytes(Number(op.slice(-1)))); push(T.f32);
      } else if (op === 'dconst_0' || op === 'dconst_1') {
        emit(OP.f64_const, ...f64bytes(Number(op.slice(-1)))); push(T.f64);
      } else if (op === 'bipush' || op === 'sipush') {
        emit(OP.i32_const, ...sleb(Number(ins.arg))); push(T.i32);
      } else if (op === 'ldc' || op === 'ldc_w') {
        const a = ins.arg;
        if (typeof a === 'number') { emit(OP.i32_const, ...sleb(a)); push(T.i32); }
        else if (a && typeof a === 'object' && !Array.isArray(a) && a.type === 'Float') {
          emit(OP.f32_const, ...f32bytes(a.value)); push(T.f32);
        } else if (a && typeof a === 'object' && !Array.isArray(a) && a.type === 'Integer') {
          emit(OP.i32_const, ...sleb(a.value)); push(T.i32);
        } else throw new Unsupported(`ldc ${JSON.stringify(a)}`);
      } else if (op === 'ldc2_w') {
        const a = ins.arg;
        if (typeof a === 'bigint') { emit(OP.i64_const, ...sleb(a)); push(T.i64); }
        else if (typeof a === 'number') { emit(OP.f64_const, ...f64bytes(a)); push(T.f64); }
        else if (a && typeof a === 'object' && a.type === 'Double') {
          emit(OP.f64_const, ...f64bytes(a.value)); push(T.f64);
        } else throw new Unsupported(`ldc2_w ${JSON.stringify(a)}`);
      } else if (op === 'aconst_null') {
        emit(OP.ref_null, T.ref); push(T.ref);
      } else if (/^[ilfda]load(_\d)?$/.test(op)) {
        const s = localArg();
        if (this.boxedSlots.has(s)) {
          const t = { i: T.i32, l: T.i64, f: T.f32, d: T.f64, a: T.ref }[op[0]];
          emit(OP.i32_const, ...sleb(s), OP.call, ...uleb(this.boxedAccess(s, t, false)));
          push(t);
        } else {
          emit(OP.local_get, ...uleb(localOf(s))); push(this.slotTypes.get(s));
        }
      } else if (/^[ilfda]store(_\d)?$/.test(op)) {
        const s = localArg();
        if (this.boxedSlots.has(s)) {
          const t = pop();
          const tmp = this.scratch(t);
          emit(OP.local_set, ...uleb(tmp), OP.i32_const, ...sleb(s),
            OP.local_get, ...uleb(tmp), OP.call, ...uleb(this.boxedAccess(s, t, true)));
        } else {
          pop(); emit(OP.local_set, ...uleb(localOf(s)));
        }
      } else if (op === 'iinc') {
        const s = Number(ins.varnum);
        if (this.boxedSlots.has(s)) {
          const tmp = this.scratch(T.i32);
          emit(OP.i32_const, ...sleb(s), OP.call, ...uleb(this.boxedAccess(s, T.i32, false)),
            OP.i32_const, ...sleb(Number(ins.incr)), OP.i32_add,
            OP.local_set, ...uleb(tmp), OP.i32_const, ...sleb(s),
            OP.local_get, ...uleb(tmp), OP.call, ...uleb(this.boxedAccess(s, T.i32, true)));
        } else {
          const l = localOf(s);
          emit(OP.local_get, ...uleb(l), OP.i32_const, ...sleb(Number(ins.incr)),
            OP.i32_add, OP.local_set, ...uleb(l));
        }
      } else if (op in BIN_OPS) {
        const [t, wop] = BIN_OPS[op];
        pop(); pop(); emit(wop); push(t);
      } else if (op === 'lshl' || op === 'lshr' || op === 'lushr') {
        pop(T.i32); emit(OP.i64_extend_i32_s);
        emit({ lshl: OP.i64_shl, lshr: OP.i64_shr_s, lushr: OP.i64_shr_u }[op]);
        pop(); push(T.i64);
      } else if (op === 'idiv') guardedDiv(T.i32, OP.i32_div_s, false);
      else if (op === 'irem') guardedDiv(T.i32, OP.i32_rem_s, true);
      else if (op === 'ldiv') guardedDiv(T.i64, OP.i64_div_s, false);
      else if (op === 'lrem') guardedDiv(T.i64, OP.i64_rem_s, true);
      else if (op === 'ineg') { emit(OP.i32_const, ...sleb(-1), OP.i32_mul); }
      else if (op === 'lneg') { emit(OP.i64_const, ...sleb(-1n), OP.i64_mul); }
      else if (op === 'fneg') { emit(OP.f32_neg); }
      else if (op === 'dneg') { emit(OP.f64_neg); }
      else if (op === 'i2l') { pop(); emit(OP.i64_extend_i32_s); push(T.i64); }
      else if (op === 'l2i') { pop(); emit(OP.i32_wrap_i64); push(T.i32); }
      else if (op === 'i2f') { pop(); emit(OP.f32_convert_i32_s); push(T.f32); }
      else if (op === 'i2d') { pop(); emit(OP.f64_convert_i32_s); push(T.f64); }
      else if (op === 'l2f') { pop(); emit(OP.f32_convert_i64_s); push(T.f32); }
      else if (op === 'l2d') { pop(); emit(OP.f64_convert_i64_s); push(T.f64); }
      else if (op === 'f2d') { pop(); emit(OP.f64_promote_f32); push(T.f64); }
      else if (op === 'd2f') { pop(); emit(OP.f32_demote_f64); push(T.f32); }
      else if (op === 'f2i') { pop(); emit(...TRUNC_SAT.i32_f32); push(T.i32); }
      else if (op === 'd2i') { pop(); emit(...TRUNC_SAT.i32_f64); push(T.i32); }
      else if (op === 'f2l') { pop(); emit(...TRUNC_SAT.i64_f32); push(T.i64); }
      else if (op === 'd2l') { pop(); emit(...TRUNC_SAT.i64_f64); push(T.i64); }
      else if (op === 'i2b') { emit(OP.i32_const, ...sleb(24), OP.i32_shl, OP.i32_const, ...sleb(24), OP.i32_shr_s); }
      else if (op === 'i2c') { emit(OP.i32_const, ...sleb(0xffff), OP.i32_and); }
      else if (op === 'i2s') { emit(OP.i32_const, ...sleb(16), OP.i32_shl, OP.i32_const, ...sleb(16), OP.i32_shr_s); }
      else if (op === 'lcmp') {
        const sb = this.scratch(T.i64); const sa = this.scratch(T.i64);
        emit(OP.local_set, ...uleb(sb), OP.local_set, ...uleb(sa));
        emit(OP.local_get, ...uleb(sa), OP.local_get, ...uleb(sb), OP.i64_gt_s);
        emit(OP.local_get, ...uleb(sa), OP.local_get, ...uleb(sb), OP.i64_lt_s);
        emit(OP.i32_sub);
        pop(); pop(); push(T.i32);
      } else if (op === 'fcmpl') fcmp(T.f32, -1);
      else if (op === 'fcmpg') fcmp(T.f32, 1);
      else if (op === 'dcmpl') fcmp(T.f64, -1);
      else if (op === 'dcmpg') fcmp(T.f64, 1);
      else if (op in ARRAY_LOAD) {
        const t = ARRAY_LOAD[op];
        pop(T.i32); pop(T.ref);
        emit(OP.call, ...uleb(this.importIndexByName.get(`aget_${sig(t)}`)));
        push(t);
      } else if (op in ARRAY_STORE) {
        const t = ARRAY_STORE[op];
        pop(); pop(T.i32); pop(T.ref);
        emit(OP.call, ...uleb(this.importIndexByName.get(`aset_${sig(t)}`)));
      } else if (op === 'arraylength') {
        pop(T.ref);
        emit(OP.call, ...uleb(this.importIndexByName.get('alen')));
        push(T.i32);
      } else if (op === 'getfield' || op === 'getstatic') {
        const st = op === 'getstatic';
        const { t, idx } = this.fieldImports(ins, st, true);
        if (!st) pop(T.ref);
        emit(OP.call, ...uleb(idx)); push(t);
      } else if (op === 'putfield' || op === 'putstatic') {
        const st = op === 'putstatic';
        const { idx } = this.fieldImports(ins, st, false);
        pop(); if (!st) pop(T.ref);
        emit(OP.call, ...uleb(idx));
      } else if (op === 'invokestatic') {
        let bound;
        try {
          bound = this.mathIntrinsic(ins);
        } catch (err) {
          if (!(err instanceof Unsupported)) throw err;
          bound = this.compiledCallee(ins);
        }
        for (let k = 0; k < bound.params.length; k++) pop();
        emit(OP.call, ...uleb(bound.idx));
        const retC = parseMethodDescriptor(ins.arg[2][1]).ret;
        if (retC !== 'V') push(descToWasm(retC));
      } else if (op === 'pop') { pop(); emit(OP.drop); }
      else if (op === 'pop2') {
        const t = pop(); emit(OP.drop);
        if (!CAT2.has(t)) { pop(); emit(OP.drop); }
      } else if (op === 'dup') {
        const t = stack[stack.length - 1];
        if (t === undefined) throw new Unsupported('dup on empty stack');
        const s = this.scratch(t);
        emit(OP.local_tee, ...uleb(s), OP.local_get, ...uleb(s));
        push(t);
      } else if (op === 'dup2') {
        const t1 = stack[stack.length - 1];
        if (t1 === undefined) throw new Unsupported('dup2 on empty stack');
        if (CAT2.has(t1)) {
          const s = this.scratch(t1);
          emit(OP.local_tee, ...uleb(s), OP.local_get, ...uleb(s));
          push(t1);
        } else {
          const t2 = stack[stack.length - 2];
          if (t2 === undefined) throw new Unsupported('dup2 underflow');
          const s1 = this.scratch(t1); const s2 = this.scratch(t2);
          emit(OP.local_set, ...uleb(s1), OP.local_set, ...uleb(s2));
          emit(OP.local_get, ...uleb(s2), OP.local_get, ...uleb(s1));
          emit(OP.local_get, ...uleb(s2), OP.local_get, ...uleb(s1));
          push(t2); push(t1);
        }
      } else if (op === 'dup_x1') {
        const t1 = pop(); const t2 = pop();
        const s1 = this.scratch(t1); const s2 = this.scratch(t2);
        emit(OP.local_set, ...uleb(s1), OP.local_set, ...uleb(s2));
        emit(OP.local_get, ...uleb(s1), OP.local_get, ...uleb(s2), OP.local_get, ...uleb(s1));
        push(t1); push(t2); push(t1);
      } else if (op === 'swap') {
        const t1 = pop(); const t2 = pop();
        const s1 = this.scratch(t1); const s2 = this.scratch(t2);
        emit(OP.local_set, ...uleb(s1), OP.local_set, ...uleb(s2));
        emit(OP.local_get, ...uleb(s1), OP.local_get, ...uleb(s2));
        push(t1); push(t2);
      } else if (BRANCH_COND[op]) {
        pop(T.i32); pop(T.i32);
        emit(BRANCH_COND[op]);
        condBranch(ins);
      } else if (op in BRANCH_ZERO) {
        pop(T.i32);
        if (op === 'iflt') { emit(OP.i32_const, ...sleb(0), OP.i32_lt_s); }
        else if (op === 'ifge') { emit(OP.i32_const, ...sleb(0), OP.i32_ge_s); }
        else if (op === 'ifgt') { emit(OP.i32_const, ...sleb(0), OP.i32_gt_s); }
        else if (op === 'ifle') { emit(OP.i32_const, ...sleb(0), OP.i32_le_s); }
        else if (op === 'ifeq') { emit(OP.i32_eqz); }
        // ifne: value is already the condition
        condBranch(ins);
      } else if (op === 'ifnull' || op === 'ifnonnull') {
        pop(T.ref);
        emit(OP.ref_is_null);
        if (op === 'ifnonnull') emit(OP.i32_eqz);
        condBranch(ins);
      } else if (op === 'if_acmpeq' || op === 'if_acmpne') {
        pop(T.ref); pop(T.ref);
        emit(OP.call, ...uleb(this.importIndexByName.get('ref_eq')));
        if (op === 'if_acmpne') emit(OP.i32_eqz);
        condBranch(ins);
      } else if (op === 'goto' || op === 'goto_w') {
        jump(this.blockOfTarget(this.targetOf(ins)), 0);
        return code; // block terminated
      } else if (op === 'ireturn' || op === 'freturn') {
        pop();
        emit(OP.call, ...uleb(this.importIndexByName.get(op === 'ireturn' ? 'ret_i' : 'ret_f')));
        emit(OP.i32_const, ...sleb(-1), OP.return);
        return code;
      } else if (op === 'lreturn' || op === 'dreturn') {
        pop();
        emit(OP.call, ...uleb(this.importIndexByName.get(op === 'lreturn' ? 'ret_l' : 'ret_d')));
        emit(OP.i32_const, ...sleb(-1), OP.return);
        return code;
      } else if (op === 'areturn') {
        pop();
        emit(OP.call, ...uleb(this.importIndexByName.get('ret_r')));
        emit(OP.i32_const, ...sleb(-1), OP.return);
        return code;
      } else if (op === 'return') {
        emit(OP.i32_const, ...sleb(-1), OP.return);
        return code;
      } else if (op === 'nop') {
        // nothing
      } else {
        throw new Unsupported(op);
      }
    }
    // fall through to next block
    if (this.blockOfItem.has(to)) {
      jump(this.blockOfItem.get(to), 0);
    } else {
      emit(OP.unreachable); // end of code without terminator (dead tail)
    }
    return code;
  }

  blockOfTarget(itemIndex) {
    const blk = this.blockOfItem.get(itemIndex);
    if (blk === undefined) throw new Unsupported(`branch into middle of a block`);
    return blk;
  }

  assemble(body) {
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
    for (const d of this.importDecls) {
      const ti = internType(d.params, d.results);
      const nameBytes = [...d.name].map((c) => c.charCodeAt(0));
      importEntries.push([3, 0x65, 0x6e, 0x76, ...uleb(nameBytes.length), ...nameBytes, 0x00, ...uleb(ti)]);
    }
    const mainParams = [...this.paramSlots.map((s) => this.slotTypes.get(s)), T.i32, T.i32]; // + blk, fuel
    const mainType = internType(mainParams, [T.i32]);
    const mainIdx = this.importDecls.length;

    const section = (id, content) => [id, ...uleb(content.length), ...content];
    const vec = (entries) => [...uleb(entries.length), ...entries.flat()];
    const localDecls = [...uleb(this.declared.length), ...this.declared.flatMap((t) => [1, t])];
    const funcBody = [...localDecls, ...body];
    const exportName = [...'run'].map((c) => c.charCodeAt(0));

    const bytes = Uint8Array.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...section(1, vec(types)),
      ...section(2, vec(importEntries)),
      ...section(3, [1, ...uleb(mainType)]),
      ...section(7, [1, exportName.length, ...exportName, 0x00, ...uleb(mainIdx)]),
      ...section(10, [1, ...uleb(funcBody.length), ...funcBody]),
    ]);

    const env = {};
    this.importDecls.forEach((d, i) => { env[d.name] = this.importFns[i]; });
    return {
      bytes,
      importObject: { env },
      box: this.box,
      paramSlots: this.paramSlots.map((s) => ({ slot: s, t: this.slotTypes.get(s) })),
      retChar: this.desc.ret,
      blockOfItem: this.blockOfItem,
      supportedBlocks: this.supportedBlocks,
      externalEntry: this.externalEntry,
      demoteReasons: this.demoteReasons,
      blockCount: this.blockStarts.length,
      fullyCompiled: this.supportedBlocks.size === this.blockStarts.length,
      normalFlowFullyCompiled: this.normalFlowFullyCompiled,
      boxedCount: this.boxedSlots.size,
    };
  }
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

const FUEL = 5_000_000;

class WasmJit {
  constructor(jvm, jit) {
    this.jvm = jvm;
    this.jit = jit;
    const env = (typeof process !== 'undefined' && process.env) || {};
    const browserDefault = typeof window !== 'undefined' && typeof document !== 'undefined';
    this.enabled = (env.JVM_WASM_JIT === '1' || browserDefault) && typeof WebAssembly !== 'undefined' &&
      !env.JVM_TRACE && env.JVM_PROFILE_HOT_METHODS !== '1';
    this.debug = env.JVM_DEBUG_WASMJIT === '1';
    // Loop-bearing methods compile on first sight: warmup by invocation count
    // never fires for methods invoked once with a multi-minute loop (va.d).
    this.warmupThreshold = Number(env.JVM_WASM_JIT_WARMUP || 1);
    this.retryBackoffMax = Math.max(1, Number(env.JVM_WASM_JIT_RETRY_BACKOFF_MAX || 4096));
    this.compileEpoch = 0;
    this.state = new WeakMap(); // method -> {entries, status, run, meta, key, runs, exits, fuelExits}
    this.compiled = [];
  }

  methodState(frame) {
    let st = this.state.get(frame.method);
    if (!st) {
      st = { entries: 0, status: 'cold', runs: 0, exits: 0, fuelExits: 0 };
      this.state.set(frame.method, st);
    }
    return st;
  }

  // shared gating/warmup/compile; returns {st, blk} when the frame can run now
  prepare(frame) {
    if (!this.enabled || !frame || !frame.method || !frame.instructions) return null;
    // Object construction and class initialization have observable all-or-
    // nothing ordering. A partial Wasm exit around new/invokespecial can leave
    // an allocated object visible without having run the rest of <init>.
    if (frame.method.name === '<init>' || frame.method.name === '<clinit>') return null;
    const debug = this.jvm.debugManager;
    if (debug && debug.debugMode) return null;

    const st = this.methodState(frame);
    if (st.status === 'failed') return null;

    if (st.status === 'cold') {
      st.entries += 1;
      const dependencyChanged = st.deferredEpoch !== undefined &&
        st.deferredEpoch !== this.compileEpoch;
      const threshold = dependencyChanged ? 1 : (st.retryAfter || this.warmupThreshold);
      if (st.entries < threshold || !this.jit.hasBackwardBranch(frame.method)) {
        return null;
      }
      this.compile(frame, st);
      if (st.status !== 'ready') return null;
    }
    if (st.status !== 'ready') return null;

    // External calls and interpreter resumptions have no wasm carry locals.
    // Enter only where the verifier shape is empty and the materialized JVM
    // operand stack agrees; non-empty shapes are reachable solely through a
    // compiled predecessor inside the same wasm run.
    const blk = st.meta.blockOfItem.get(frame.pc);
    if (blk === undefined || !st.meta.externalEntry.has(blk) || !frame.stack.isEmpty()) return null;
    return { st, blk };
  }

  tryRunFrame(frame, thread) {
    const prep = this.prepare(frame);
    if (!prep) return { handled: false };
    return this.execute(frame, thread, prep.st, prep.blk);
  }

  // Called from the JS-jit runner's invoke() for freshly pushed child frames,
  // which never pass through tryRunFrame. On return the child is popped and
  // the value handed back to invoke(); on a transient exit the child stays on
  // the stack with frame.pc at the resume point and the runner continues it.
  runNested(frame, thread, options = {}) {
    const prep = this.prepare(frame);
    if (!prep) return { handled: false };
    if (options.requireNormalFlowFullyCompiled && !prep.st.meta.normalFlowFullyCompiled) {
      return { handled: false };
    }
    const result = this.execute(frame, thread, prep.st, prep.blk, true);
    if (result.returned) {
      return { returned: true, isVoid: prep.st.meta.retChar === 'V', value: prep.st.meta.box.ret };
    }
    return { exited: true };
  }

  compile(frame, st, options = {}) {
    const asCallee = options.asCallee === true;
    const isRecompile = st.status === 'ready';
    const className = frame.className || (frame.method.className) || '?';
    st.key = `${className}.${frame.method.name}${frame.method.descriptor}`;
    // Prevent recursive static call graphs from trying to compile the same
    // method again while its translator is still discovering callees.
    st.status = 'compiling';
    try {
      const translator = new MethodTranslator(this.jvm, frame.method, className, this);
      const meta = translator.translate();
      if (asCallee) {
        // A linked callee cannot spill back into a Java frame in the middle of
        // its synchronous wasm import. Its normal flow must therefore be
        // complete and unboxed; handler-only diagnostic reporters may remain
        // outside Wasm. It need not contain a loop: removing the call boundary
        // is precisely what lets the caller's loop remain compiled.
        if (!meta.normalFlowFullyCompiled || meta.boxedCount) {
          throw new Unsupported('callee is not fully compiled');
        }
      } else {
        // Standalone entry has call/materialization overhead, so require at
        // least one fully compiled loop.
        const hasCompiledLoop = this.hasSupportedBackwardBranch(frame.method, meta);
        if (!hasCompiledLoop) {
          if (this.debug && meta.demoteReasons.size) {
            const details = [...meta.demoteReasons.entries()]
              .map(([block, reason]) => `${block}:${reason}`).join(', ');
            console.error(`[wasmjit] no compiled loop ${st.key}: ${details}`);
          }
          throw new Unsupported('no compiled loop');
        }
      }
      const module = new WebAssembly.Module(meta.bytes);
      const instance = new WebAssembly.Instance(module, meta.importObject);
      st.meta = meta;
      st.run = instance.exports.run;
      st.status = 'ready';
      st.retryAfter = undefined;
      st.deferredEpoch = undefined;
      st.calleeDeferredEpoch = undefined;
      this.compileEpoch += 1;
      if (!isRecompile) this.compiled.push(st);
      if (this.debug) {
        console.error(`[wasmjit] ${isRecompile ? 'recompiled' : 'compiled'} ${st.key}: ${meta.bytes.length}B, ` +
          `${meta.supportedBlocks.size}/${meta.blockCount} blocks` +
          (meta.demoteReasons.size ? ` (exits: ${[...meta.demoteReasons.values()].join('; ')})` : ''));
      }
    } catch (err) {
      if (isRecompile) {
        // keep the previous working module
        st.status = 'ready';
        if (this.debug) console.error(`[wasmjit] recompile of ${st.key} failed (${err.message}), keeping old module`);
        return;
      }
      if (asCallee && err instanceof Unsupported) {
        // Callee linking is stricter than standalone execution. A failed link
        // must not blacklist the method from later standalone compilation.
        // Reconsider it as a callee after some other dependency compiles.
        st.calleeDeferredEpoch = this.compileEpoch;
        st.status = 'cold';
        st.entries = 0;
        if (this.debug) console.error(`[wasmjit] deferred callee ${st.key}: ${err.message}`);
        return;
      }
      // "no compiled loop" is often transient: a class or numeric callee may
      // become ready later in startup. Never permanently blacklist that
      // method. A successful compilation elsewhere retries it immediately;
      // otherwise use bounded exponential entry backoff.
      if (err instanceof Unsupported && err.message === 'no compiled loop') {
        const previous = st.retryAfter || Math.max(1, this.warmupThreshold);
        st.retryAfter = Math.min(this.retryBackoffMax, previous * 2);
        st.deferredEpoch = this.compileEpoch;
        st.status = 'cold';
        st.entries = 0;
        if (this.debug) console.error(`[wasmjit] deferred ${st.key}: no compiled loop yet ` +
          `(retry after ${st.retryAfter} entries or dependency compilation)`);
        return;
      }
      st.status = 'failed';
      st.failReason = err.message;
      if (this.debug) console.error(`[wasmjit] rejected ${st.key}: ${err.message}`);
    }
  }

  hasSupportedBackwardBranch(method, meta) {
    const code = method.attributes.find((a) => a.type === 'code');
    const items = code.code.codeItems;
    const labels = new Map();
    items.forEach((it, i) => { if (it.labelDef) labels.set(it.labelDef.slice(0, -1), i); });
    return items.some((item, index) => {
      const op = getOp(item.instruction);
      if (!op || (op !== 'goto' && !op.startsWith('if'))) return false;
      const target = item.instruction && typeof item.instruction === 'object'
        ? labels.get(item.instruction.arg) : undefined;
      if (target === undefined || target > index) return false;
      // both the branch's block and the target block must be compiled
      const blkOfBranch = this.blockOf(meta, index);
      const blkOfTarget = meta.blockOfItem.get(target);
      return blkOfTarget !== undefined && meta.supportedBlocks.has(blkOfTarget) &&
        blkOfBranch !== undefined && meta.supportedBlocks.has(blkOfBranch);
    });
  }

  blockOf(meta, itemIndex) {
    let blk;
    for (const [start, b] of meta.blockOfItem) {
      if (start <= itemIndex) blk = b; else break;
    }
    return blk;
  }

  execute(frame, thread, st, blk, nested = false) {
    const meta = st.meta;
    meta.box.frame = frame;
    meta.box.ret = undefined;
    const args = new Array(meta.paramSlots.length + 2);
    for (let i = 0; i < meta.paramSlots.length; i++) {
      const { slot, t } = meta.paramSlots[i];
      const v = frame.locals[slot];
      if (t === T.i32 && typeof v === 'boolean') args[i] = v ? 1 : 0;
      else args[i] = toWasmValue(t, v);
    }
    args[meta.paramSlots.length] = blk;
    args[meta.paramSlots.length + 1] = FUEL;

    st.runs += 1;
    const status = st.run(...args);

    if (status === -1) {
      thread.callStack.pop();
      if (!nested && meta.retChar !== 'V' && !thread.callStack.isEmpty()) {
        thread.callStack.peek().stack.push(meta.box.ret);
      }
      return { handled: true, returned: true };
    }
    // transient exit: locals already spilled by the stub; resume interpreter here
    st.exits += 1;
    if (status === frame.pc) st.fuelExits += 1; // fuel exit at entry pc is possible but rare
    frame.pc = status;
    // Exit storms usually mean a loop keeps leaving wasm for an invoke whose
    // callee wasn't compiled yet — recompile to bind callees that are now ready.
    if (st.exits % 20000 === 0 && (st.recompiles || 0) < 3 && st.meta.demoteReasons.size) {
      st.recompiles = (st.recompiles || 0) + 1;
      this.compile(frame, st);
    }
    return { handled: true };
  }

  findReadyStatic(className, name, descriptor) {
    const cd = this.jvm.classes[className];
    const clsAst = cd && cd.ast && cd.ast.classes[0];
    if (!clsAst) return null;
    const method = clsAst.items.filter((i) => i.type === 'method').map((i) => i.method)
      .find((m) => m.name === name && m.descriptor === descriptor);
    if (!method || !(method.flags || []).includes('static')) return null;
    let st = this.state.get(method);
    if (!st) st = this.methodState({ method });
    if (st.status === 'cold' && st.calleeDeferredEpoch !== this.compileEpoch) {
      const hasClassInitializer = clsAst.items
        .filter((i) => i.type === 'method')
        .some((i) => i.method.name === '<clinit>');
      // Linking must not bypass an observable class initializer. Classes with
      // no <clinit> are safe because their initialization has no Java code.
      if (!hasClassInitializer || this.jvm.classInitializationState.get(className) === 'INITIALIZED') {
        this.compile({ method, className }, st, { asCallee: true });
      }
    }
    return st && st.status === 'ready' && st.meta.normalFlowFullyCompiled && !st.meta.boxedCount
      ? st : null;
  }

  dumpStats() {
    for (const st of this.compiled) {
      console.error(`[wasmjit] ${st.key}: runs=${st.runs} exits=${st.exits}`);
    }
  }
}

module.exports = WasmJit;
module.exports._test = { isNoOpExceptionHandler, toWasmValue, T };
