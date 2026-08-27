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

const { resolveInstanceFieldKey, runtimeClassName } = require('../instructions/object');
const {
  addMathImport, addTimeImport, addNewArrayImport, addANewArrayImport,
  addNewImport, addTypedArrayStoreImports, arrayTracer,
  addI32ArrayLoadImports,
} = require('./wasmRuntimeImports');
const { ClassHierarchy } = require('../analysis/closedWorld/classHierarchy');
const { revalidateSpeculations } = require('./wasmInline');
const Frame = require('../core/frame');
const {
  T, CAT2, OP, TRUNC_SAT,
  uleb, sleb, f32bytes, f64bytes,
  wasmProfilerName, wasmFunctionNameSection,
  getOp, descToWasm, toWasmValue, parseMethodDescriptor, sig,
  NPE, AIOOBE,
  BRANCH_COND, BRANCH_ZERO, ICONST, BIN_OPS, ARRAY_LOAD, ARRAY_STORE,
  arrayLoadImportName,
  Unsupported,
  blockedNames,
  NestedDeopt,
  isGuestThrow,
  FUEL,
  isNoOpExceptionHandler, liveExceptionRanges, supportsWasmTryTable,
  retvGlobalEntry, runvWrapperBody, specokGlobalEntry,
  maxImpls,
} = require('./wasmShared');
const monoArray = require('./monoArray');
const {
  normalizeArrayLoad,
  normalizeArrayStore,
} = require('../instructions/utils');
const { expandWideInstruction } = require('../instructions');

// Demote reasons a later class load can undo: an unresolved dispatch, a callee
// whose module is not compiled yet, an uninitialized class at a `new`, or an
// unresolved static owner. Permanent reasons (an unsupported opcode, a disabled
// feature) never match, so a module demoted only for those is never rebuilt.
const nowMs = () => (typeof performance !== 'undefined' && performance.now
  ? performance.now() : Date.now());

const DEFERRABLE_DEMOTE =
  /unresolved|not ready|not initialized|no ready impl|vetoed|not fully compiled/;

// Of those, the ones no runtime mechanism can repair. A dispatcher-tier module
// is otherwise left alone because late instance-target installation rescues a
// dispatch site that merely missed — but that only ever helps a site that
// COMPILED. A static callee that had no module yet, and a static field whose
// cell did not exist, leave a demoted block with no import to install anything
// into, so a rebuild is the only thing that can recover them. Measured on
// runTile, whose last module was a dispatcher one demoted at the makeTile
// call: the gate was skipped 548 times while its blocker signature had already
// moved.
const UNSERVICEABLE_DEMOTE = /callee not ready|unresolved static/;

const EMPTY_WRITE_SET = new Set();
const capturesBooleanStaticCache = new WeakMap();

function capturesBooleanStatic(method) {
  if (method && capturesBooleanStaticCache.has(method)) {
    return capturesBooleanStaticCache.get(method);
  }
  const code = method && method.attributes &&
    method.attributes.find((attribute) => attribute.type === 'code');
  const items = code && code.code && code.code.codeItems;
  const localIndex = (instruction, op, prefix) => {
    if (op.length === prefix.length + 2 && op.startsWith(`${prefix}_`)) {
      const compact = op.charCodeAt(op.length - 1) - 48;
      if (compact >= 0 && compact <= 3) return compact;
    }
    if (op !== prefix) return null;
    const value = instruction && typeof instruction === 'object'
      ? instruction.varnum ?? instruction.arg
      : null;
    const numeric = Number(value);
    return Number.isInteger(numeric) ? numeric : null;
  };
  const result = Boolean(items && items.some((item, index) => {
    const instruction = item && item.instruction;
    if (!(getOp(instruction) === 'getstatic' &&
      Array.isArray(instruction.arg) &&
      Array.isArray(instruction.arg[2]) &&
      instruction.arg[2][1] === 'Z')) return false;
    for (let next = index + 1; next < items.length; next += 1) {
      const nextInstruction = items[next] && items[next].instruction;
      const nextOp = getOp(nextInstruction);
      if (!nextOp) continue;
      const capturedLocal = localIndex(nextInstruction, nextOp, 'istore');
      if (capturedLocal === null) return false;
      let crossedCall = false;
      for (let use = next + 1; use < items.length; use += 1) {
        const useInstruction = items[use] && items[use].instruction;
        const useOp = getOp(useInstruction);
        if (!useOp) continue;
        if (useOp && useOp.startsWith('invoke')) crossedCall = true;
        if (localIndex(useInstruction, useOp, 'istore') === capturedLocal) return false;
        if (localIndex(useInstruction, useOp, 'iload') === capturedLocal) {
          return crossedCall;
        }
      }
      return false;
    }
    return false;
  }));
  if (method) capturesBooleanStaticCache.set(method, result);
  return result;
}




class MethodTranslator {
  constructor(jvm, method, className, wasmJit) {
    this.jvm = jvm;
    this.method = method;
    this.className = className;
    this.wasmJit = wasmJit;
    const codeAttr = method.attributes.find((a) => a.type === 'code');
    this.items = codeAttr.code.codeItems.map((item) => {
      const instruction = item && item.instruction;
      if (getOp(instruction) !== 'wide') return item;
      const expanded = expandWideInstruction(instruction);
      return expanded ? { ...item, instruction: expanded } : item;
    });
    this.desc = parseMethodDescriptor(method.descriptor);
    this.isStatic = (method.flags || []).includes('static');

    this.labelIndex = new Map();
    this.items.forEach((it, i) => {
      if (it.labelDef) this.labelIndex.set(it.labelDef.slice(0, -1), i);
    });

    this.importFns = [];        // JS functions in index order
    this.importDecls = [];      // {name, params:[wasmtype], results:[wasmtype]}
    this.importIndexByName = new Map();
    this.box = {
      frame: null, ret: undefined,
      pendingException: null, lastThrown: null, throwPc: -1,
    };
    this.demoteReasons = new Map();
    // Guest classes named by a recoverable refusal; see Unsupported.blockedOn.
    this.demoteBlockers = new Set();
  }

  targetOf(ins) {
    const idx = this.labelIndex.get(ins.arg);
    if (idx === undefined) throw new Unsupported(`unknown label ${ins.arg}`);
    return idx;
  }

  // Bytecode pc of a block's first instruction (the space handleException
  // compares handler ranges in), or null when the block has no label or
  // pc-annotated item to derive it from.
  pcOfBlock(b) {
    const from = this.blockStarts[b];
    const to = b + 1 < this.blockStarts.length ? this.blockStarts[b + 1] : this.items.length;
    for (let i = from; i < to; i++) {
      const it = this.items[i];
      if (!it) continue;
      if (it.labelDef) {
        const pc = parseInt(it.labelDef.slice(1, -1), 10);
        if (!Number.isNaN(pc)) return pc;
      }
      if (typeof it.pc === 'number') return it.pc;
    }
    return null;
  }

  // ---- import registry ----
  addImport(name, params, results, fn) {
    if (this.importIndexByName.has(name)) return this.importIndexByName.get(name);
    const idx = this.importDecls.length;
    let wrapped = fn;
    if (this.ehMethod) {
      // EH protocol (mirrors the structured tier): record what an import
      // threw so the catch_all arm — which cannot inspect the exception —
      // can tell guest exceptions from host errors.
      const box = this.box;
      wrapped = (...args) => {
        try {
          return fn(...args);
        } catch (e) {
          box.lastThrown = e;
          box.pendingException = isGuestThrow(e) ? e : null;
          throw e;
        }
      };
    }
    this.importDecls.push({ name, params, results });
    this.importFns.push(wrapped);
    this.importIndexByName.set(name, idx);
    return idx;
  }

  arrayImports() {
    const self = this;
    const name = this.method.name;
    // Same array trace as the structured backend so the two tiers' accesses
    // can be diffed one for one (see wasmRuntimeImports.arrayTracer).
    const trace = arrayTracer(
      `${this.className}.${this.method.name}${this.method.descriptor}`);
    const mk = (suffix, t) => {
      // Each import has one fixed result type, and element access goes through
      // monoArray so each backing class (plain Array vs the wasm-heap
      // TypedArray views) keeps its own monomorphic keyed IC — one shared
      // `a[i]` site over that mix goes megamorphic and dominates the profile.
      const load = t === T.i32
        ? (a, i) => {
          if (trace) trace(`aget_${suffix}`, a, i);
          if (a === null || a === undefined) throw NPE(`Attempted load on null array in ${name}`);
          const value = monoArray.load(a, i);
          if (value === monoArray.OOB) throw AIOOBE(i, monoArray.len(a));
          return normalizeArrayLoad(value, null, a);
        }
        : (a, i) => {
          if (trace) trace(`aget_${suffix}`, a, i);
          if (a === null || a === undefined) throw NPE(`Attempted load on null array in ${name}`);
          const value = monoArray.load(a, i);
          if (value === monoArray.OOB) throw AIOOBE(i, monoArray.len(a));
          return t === T.ref ? value : toWasmValue(t, value);
        };
      self.addImport(`aget_${suffix}`, [T.ref, T.i32], [t], load);
      if (!self.wasmJit.typedArrayStoresEnabled) {
        self.addImport(`aset_${suffix}`, [T.ref, T.i32, t], [], (a, i, v) => {
          if (trace) trace(`aset_${suffix}`, a, i);
          if (a === null || a === undefined) {
            throw NPE(`Attempted store on null array in ${name}`);
          }
          if (!monoArray.store(a, i, normalizeArrayStore(v, null, a))) {
            throw AIOOBE(i, monoArray.len(a));
          }
        });
      }
    };
    mk('i', T.i32); mk('l', T.i64); mk('f', T.f32); mk('d', T.f64); mk('r', T.ref);
    addI32ArrayLoadImports(self, name, trace);
    if (self.wasmJit.typedArrayStoresEnabled) {
      addTypedArrayStoreImports(self, name,
        `${self.className}.${self.method.name}${self.method.descriptor}`);
    }
    self.addImport('alen', [T.ref], [T.i32], (a) => {
      if (a === null || a === undefined) throw NPE(`Attempted to get length of null array in ${name}`);
      return monoArray.len(a);
    });
  }

  runtimeImports() {
    const box = this.box;
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

  // ---- redundant field-load caching ----
  // getstatic results and `aload s; getfield f` results are kept in a pair of
  // wasm locals (value + filled flag). Repeated reads inside one wasm run —
  // including across loop iterations — become a branch on the flag instead of
  // a wasm->JS import call. Soundness:
  //  - locals zero on every run() entry, so caches start invalid per run;
  //  - a putfield/putstatic of the same name:descriptor clears every matching
  //    flag (inheritance can alias distinct owner classes onto one storage
  //    key, so the kill ignores the owner);
  //  - a linked wasm callee clears the flags matching its transitive
  //    field-write summary (WasmJit.staticWriteSummary); callees whose writes
  //    are unknowable clear all flags, and Math intrinsics clear none;
  //  - a store to slot s clears caches keyed on s and strips the compile-time
  //    provenance of values already on the simulated stack, so a stale
  //    receiver can never seed a cache for the slot's new object;
  //  - no import in this tier runs guest code or a thread switch, so nothing
  //    else can write a field mid-run.
  // The first (dry) pass discovers the full cache-entry set; pass 2 reuses
  // that set so kill sites cover entries whose fills compile later.
  refScratchLocal() {
    if (this.refScratch === undefined) {
      this.refScratch = this.nextLocal++;
      this.declared.push(T.ref);
    }
    return this.refScratch;
  }

  fieldCacheFor(cacheKey, t, killKey, slot, kind) {
    let entry = this.fieldCaches.get(cacheKey);
    if (!entry) {
      const valLocal = this.nextLocal++;
      this.declared.push(t);
      const filledLocal = this.nextLocal++;
      this.declared.push(T.i32);
      entry = { valLocal, filledLocal, t, killKey, slot, kind };
      this.fieldCaches.set(cacheKey, entry);
    }
    return entry;
  }

  killSeqWhere(predicate) {
    const seq = [];
    for (const entry of this.fieldCaches.values()) {
      if (predicate(entry)) {
        seq.push(OP.i32_const, ...sleb(0), OP.local_set, ...uleb(entry.filledLocal));
      }
    }
    return seq;
  }

  // emit: read through the cache entry; on miss run `loadSeq` (which must
  // leave exactly the loaded value on the wasm stack) and fill the cache
  cachedReadSeq(entry, loadSeq) {
    return [
      OP.local_get, ...uleb(entry.filledLocal), OP.if, entry.t,
      OP.local_get, ...uleb(entry.valLocal),
      OP.else, ...loadSeq,
      OP.local_set, ...uleb(entry.valLocal),
      OP.i32_const, ...sleb(1), OP.local_set, ...uleb(entry.filledLocal),
      OP.local_get, ...uleb(entry.valLocal), OP.end,
    ];
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
      if (!container) {
        // Name the FIELD, not its class: static field cells are created
        // lazily on first write, so the class is routinely initialized long
        // before the cell exists and class readiness would never move again.
        throw new Unsupported(`unresolved static ${className}.${fieldName}`,
          `${className}.${fieldName}:${descriptor}`);
      }
      const name = `${isGet ? 'gs' : 'ps'}_${className}_${fieldName}`.replace(/[^\w]/g, '_');
      const getStatic = t === T.i32
        ? () => {
          const value = container.get(key);
          return typeof value === 'boolean' ? (value ? 1 : 0) : value;
        }
        : t === T.ref ? () => container.get(key)
          : () => toWasmValue(t, container.get(key));
      return {
        t,
        name,
        idx: isGet
          ? this.addImport(name, [], [t], getStatic)
          : this.addImport(name, [t], [], (v) => container.set(key, v)),
      };
    }
    const name = `${isGet ? 'gf' : 'pf'}_${className}_${fieldName}`.replace(/[^\w]/g, '_');
    const keyCache = new Map();
    // Almost every site is monomorphic; keep the last class's key one
    // identity compare away instead of a Map lookup per access.
    let cachedClassName;
    let cachedFieldKey;
    const resolveKey = (obj) => {
      const ct = obj._className || obj.type;
      if (ct === cachedClassName) return cachedFieldKey;
      let key = keyCache.get(ct);
      if (key === undefined) {
        key = resolveInstanceFieldKey(jvm, obj, className, fieldName) || `${className}.${fieldName}`;
        keyCache.set(ct, key);
      }
      cachedClassName = ct;
      cachedFieldKey = key;
      return key;
    };
    const getInstance = t === T.i32
      ? (obj) => {
        if (obj === null || obj === undefined) {
          throw { type: 'java/lang/NullPointerException', message: null };
        }
        const key = resolveKey(obj);
        const value = obj.fields
          ? obj.fields[key]
          : (obj[key] ?? obj[fieldName]);
        return typeof value === 'boolean' ? (value ? 1 : 0) : value;
      }
      : t === T.ref
        ? (obj) => {
          if (obj === null || obj === undefined) {
            throw { type: 'java/lang/NullPointerException', message: null };
          }
          const key = resolveKey(obj);
          return obj.fields ? obj.fields[key] : (obj[key] ?? obj[fieldName]);
        }
        : (obj) => {
          if (obj === null || obj === undefined) {
            throw { type: 'java/lang/NullPointerException', message: null };
          }
          const key = resolveKey(obj);
          return toWasmValue(t,
            obj.fields ? obj.fields[key] : (obj[key] ?? obj[fieldName]));
        };
    return {
      t,
      name,
      idx: isGet
        ? this.addImport(name, [T.ref], [t], getInstance)
        : this.addImport(name, [T.ref, t], [], (obj, v) => {
          if (obj === null || obj === undefined) {
            throw { type: 'java/lang/NullPointerException', message: null };
          }
          const key = resolveKey(obj);
          if (obj.fields) obj.fields[key] = v;
          else if (Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = v;
          else obj[fieldName] = v;
        }),
    };
  }

  mathIntrinsic(ins) {
    return addMathImport(this, ins);
  }

  // invokestatic bound directly to another compiled wasm method. A callee
  // whose NORMAL flow still contains unsupported blocks may link as
  // "partial": the obfuscator's if-(never)-guarded diagnostic paths are the
  // dominant shape, so the call runs entirely in wasm and only pays when a
  // guard actually flips. The caller spills its typed slots before such a
  // call; if the callee (or anything it linked) reaches a demoted block, the
  // import materializes real interpreter frames for the whole nested chain
  // and unwinds with NestedDeopt. Runtime counters veto callees whose
  // "never" path turns out hot, and the caller's periodic recompile then
  // drops the link.
  compiledCallee(ins, itemIndex, underTypes) {
    const [, className, [name, descriptor]] = ins.arg;
    const { params, ret } = parseMethodDescriptor(descriptor);
    if (![...params, ret].every((c) => 'IJFDZBCSV[L'.includes(c))) {
      throw new Unsupported(`invoke ${className}.${name} unsupported descriptor`);
    }
    const calleeSt = this.wasmJit &&
      this.wasmJit.findReadyStatic(className, name, descriptor, true);
    if (!calleeSt || (calleeSt.callee || calleeSt).meta.boxedCount) {
      // Name the callee METHOD, not its class: what has to change before a
      // rebuild could link this site is that method owning a module, and its
      // class is typically initialized already. See blockerSignature.
      throw new Unsupported(`invoke ${className}.${name} callee not ready`,
        `${className}.${name}${descriptor}`);
    }
    const calleeMeta = (calleeSt.callee || calleeSt).meta;
    if (calleeMeta.usedEh) {
      // An EH module returns -3 with its spill import aimed at the top
      // frame; a partial-link resume at the throw pc would also re-execute
      // the throwing op. Never link these — the scheduler runs them.
      throw new Unsupported(`callee ${className}.${name} has EH sites`);
    }
    const partial = !calleeMeta.fullyCompiled || calleeMeta.deoptableCalls > 0;
    if (partial && calleeSt.linkVetoed) {
      throw new Unsupported(`partial callee ${className}.${name} vetoed`);
    }
    // Direct wasm->wasm link: a fully-compiled callee with the identity
    // slot->argument mapping is called through its runv export — the wasm
    // engine calls the imported wasm function directly, with no JS bridge,
    // argument marshalling, or frame bookkeeping on the path. The link pins
    // this instance exactly like the non-partial bridge's pinned fallback; a
    // caller recompile refreshes it. The status word is checked in wasm and
    // traps on the (never-observed) nested exit that the bridge would have
    // turned into an Error.
    // An EH caller records what each import threw (box.lastThrown) so its
    // catch_all can classify exceptions; a raw wasm import would bypass the
    // recorder, so EH methods keep the JS bridge.
    if (!partial && this.wasmJit && this.wasmJit.directStaticLinkEnabled &&
        calleeMeta.runv && !this.ehMethod) {
      const identity = calleeMeta.paramSlots.length === params.length &&
        calleeMeta.paramSlots.every((p, i) => {
          let slot = 0;
          for (let k = 0; k < i; k++) slot += (params[k] === 'J' || params[k] === 'D') ? 2 : 1;
          return p.slot === slot && p.t === descToWasm(params[i]);
        });
      if (identity) {
        const key = `${className}.${name}${descriptor}`;
        const importName = `dcall_${key}`.replace(/[^\w]/g, '_');
        const wParams = params.map(descToWasm);
        const wResults = ret === 'V' ? [T.i32] : [T.i32, descToWasm(ret)];
        return {
          argTypes: wParams,
          underTypes: [],
          partial: false,
          direct: true,
          retType: ret === 'V' ? null : descToWasm(ret),
          idx: this.addImport(importName, wParams, wResults, calleeMeta.runv),
        };
      }
    }
    // A deopt resumes the caller interpreted just after the invoke; values
    // under the arguments ride through the import so the deopt path can
    // rebuild the operand stack. Fully-compiled callees never deopt and
    // skip the shuffle entirely.
    // A partial static link can propagate a NestedDeopt through this module,
    // so it makes this module deoptable for ITS callers exactly like an
    // instance site does; non-partial links stay non-deoptable because they
    // pin a fully-compiled, zero-deoptable-site module.
    if (partial) this.instanceSites = (this.instanceSites || 0) + 1;
    const underCount = partial ? underTypes.length : 0;
    const unders = partial ? underTypes : [];
    // java arg slot -> position in the wasm arg list
    const argPosBySlot = new Map();
    let slot = 0;
    params.forEach((p, i) => { argPosBySlot.set(slot, i); slot += (p === 'J' || p === 'D') ? 2 : 1; });
    const wParams = [...unders, ...params.map(descToWasm)];
    const results = ret === 'V' ? [] : [descToWasm(ret)];
    const key = `${className}.${name}${descriptor}`;
    const callerBox = this.box;
    const resumePc = itemIndex + 1;
    let scratchFrame = null;
    // Non-partial sites skip the empty-under-stack requirement, so their
    // callee must never deopt. A recompile may repoint the state to a module
    // with instance-dispatch sites (which can miss); pin the link-time pair
    // as the safe fallback for those sites.
    const pinned = { run: (calleeSt.callee || calleeSt).run, meta: calleeMeta };
    const fn = (...all) => {
      const args = underCount ? all.slice(underCount) : all;
      const current = calleeSt.callee || calleeSt;
      // A dependency-world recompile resets the callee state (meta/run/callee
      // all null) while this closure is still reachable from a running caller
      // module; the pinned link-time pair is the designed fallback for every
      // repointed state, so a reset state must take it too.
      const currentMeta = current.meta;
      const calleeMod = (currentMeta && ((partial && !currentMeta.usedEh) ||
        (currentMeta.fullyCompiled && !currentMeta.deoptableCalls &&
          !currentMeta.boxedCount && !currentMeta.usedEh))) ? current : pinned;
      const meta = calleeMod.meta;
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
      let frame;
      if (partial) {
        calleeSt.nestedCalls = (calleeSt.nestedCalls || 0) + 1;
        // The scratch frame stays clean unless the callee actually exits
        // (spill/push imports only run in exit stubs), so it is reused
        // forever on the never-deopts path. Recursion through the same site
        // gets a throwaway frame.
        if (scratchFrame && !scratchFrame.inUse) {
          frame = scratchFrame;
          frame.pc = 0;
        } else {
          frame = new Frame(calleeSt.method);
          frame.className = className;
          if (!scratchFrame) scratchFrame = frame;
        }
        frame.inUse = true;
      } else {
        frame = { locals: [] }; // junk sink should a fuel exit ever spill
      }
      meta.box.frame = frame;
      meta.box.ret = undefined;
      let status;
      try {
        status = calleeMod.run(...full);
      } catch (err) {
        if (partial && err instanceof NestedDeopt) {
          // the deeper site set frame.pc through its own callerBox
          err.frames.push(frame);
          if (frame === scratchFrame) scratchFrame = null;
          callerBox.frame.pc = resumePc;
          for (let i = 0; i < underCount; i++) callerBox.frame.stack.push(all[i]);
        }
        throw err;
      } finally {
        if (partial) frame.inUse = false;
        meta.box.frame = savedFrame;
      }
      if (status !== -1) {
        if (!partial) throw new Error(`wasmjit: nested callee ${key} exited at ${status}`);
        frame.pc = status;
        if (frame === scratchFrame) scratchFrame = null; // donated to the call stack
        callerBox.frame.pc = resumePc;
        for (let i = 0; i < underCount; i++) callerBox.frame.stack.push(all[i]);
        calleeSt.nestedDeopts = (calleeSt.nestedDeopts || 0) + 1;
        if (calleeSt.nestedDeopts > 256 &&
            calleeSt.nestedDeopts * 4 > calleeSt.nestedCalls) {
          calleeSt.linkVetoed = true;
        }
        // a structured callee's own call-site deopt parks deeper frames on
        // its box; they sit below the callee frame, innermost first
        const deeper = meta.box.pendingFrames;
        meta.box.pendingFrames = null;
        throw new NestedDeopt(deeper ? [...deeper, frame] : [frame]);
      }
      return meta.box.ret;
    };
    // partial sites need a distinct import per call site: the resume pc is
    // baked into the closure
    const importName = `call_${key}${partial ? `_${itemIndex}` : ''}`.replace(/[^\w]/g, '_');
    return {
      argTypes: wParams.slice(underCount),
      underTypes: unders,
      partial,
      idx: this.addImport(importName, wParams, results, fn),
    };
  }

  // invokevirtual/invokeinterface/invokespecial bound through a complete
  // closed-world dispatch table: the import selects the target module by the
  // receiver's runtime class. invokespecial is the statically-bound
  // degenerate case. A map miss may install an exact later-loaded target when
  // its writes fit the caller's already-emitted cache kills. Other misses
  // deopt to the interpreter AT the invoke: the import restores the receiver
  // and arguments onto the caller's operand stack — materializable because
  // linking requires nothing underneath them — and the interpreter
  // re-executes the site with full dynamic dispatch. A null receiver throws
  // the guest NPE like err_div0; per-block demotion keeps compiled blocks outside live
  // handler ranges. Any target may deopt (partial) or miss, so the caller
  // spills its typed slots before every instance call.
  compiledInstanceCallee(ins, itemIndex, underTypes, op) {
    const [, owner, [name, descriptor]] = ins.arg;
    // invokespecial <init> is statically bound to exactly the named owner's
    // constructor; it is linkable when that constructor compiles fully, so
    // the linked call runs all-or-nothing (completes or throws) exactly like
    // native construction. Partial exits mid-<init> stay excluded below.
    if (name === '<clinit>' || (name === '<init>' && op !== 'invokespecial')) {
      throw new Unsupported(`${op} ${owner}.${name}`);
    }
    const { params, ret } = parseMethodDescriptor(descriptor);
    if (![...params, ret].every((c) => 'IJFDZBCSV[L'.includes(c))) {
      throw new Unsupported(`invoke ${owner}.${name} unsupported descriptor`);
    }
    if (!this.wasmJit || !this.wasmJit.instanceLinkEnabled) {
      throw new Unsupported('instance linking disabled');
    }
    const hierarchy = this.wasmJit.hierarchy;
    // runtime class -> target method state; invokespecial uses a single
    // statically-bound target for every receiver
    let dispatch = null;
    let direct = null;
    let resolvedCone = null;
    // What each of these waits on is the IMPL METHOD owning a module, so that
    // is what they name; its class is usually initialized well before it.
    const implKey = (implClassName) => `${implClassName}.${name}${descriptor}`;
    const readyOrThrow = (implClassName) => {
      const st = this.wasmJit.findReadyInstance(implClassName, name, descriptor);
      if (!st) {
        throw new Unsupported(`invoke ${owner}.${name} impl ${implClassName} not ready`,
          implKey(implClassName));
      }
      if (st.linkVetoed && !(st.callee || st).meta.fullyCompiled) {
        throw new Unsupported(`partial callee ${implClassName}.${name} vetoed`,
          implKey(implClassName));
      }
      return st;
    };
    if (op === 'invokespecial') {
      const impl = name === '<init>'
        ? hierarchy.resolveInit(owner, descriptor)
        : hierarchy.resolveSpecial(this.className, owner, name, descriptor);
      if (!impl) throw new Unsupported(`invokespecial ${owner}.${name} unresolved`, owner);
      direct = readyOrThrow(impl.className);
      if (name === '<init>') {
        // all-or-nothing: a constructor target must be unable to hand the
        // call back mid-body — it either completes or throws
        const m = (direct.callee || direct).meta;
        if (!m.fullyCompiled || m.deoptableCalls || m.usedEh) {
          throw new Unsupported(`<init> ${owner} target not fully compiled`
            + (this.wasmJit && this.wasmJit.debug
              ? ` [full=${m.fullyCompiled} normalFlow=${m.normalFlowFullyCompiled}`
                + ` deoptableCalls=${m.deoptableCalls} usedEh=${m.usedEh}`
                + ` demotes=${JSON.stringify([...(m.demoteReasons || [])])}]` : ''),
          implKey(impl.className));
        }
      }
    } else {
      const resolved = hierarchy.resolveDispatch(owner, name, descriptor);
      resolvedCone = resolved;
      if (!resolved) throw new Unsupported(`invoke ${owner}.${name} unresolved`, owner);
      // See the note on this limit in StructuredWasmCompiler.
      if (resolved.impls.size > maxImpls()) {
        throw new Unsupported(`invoke ${owner}.${name} megamorphic`);
      }
      // Impls that cannot be linked (never-compiling entry, EH module,
      // vetoed) drop out of the map: their receivers miss at runtime and
      // take the existing deopt-at-the-invoke path, which is always sound.
      // Only a site with no ready impl at all keeps the demotion status quo.
      const readyByImpl = new Map();
      let readyCount = 0;
      for (const impl of resolved.impls.values()) {
        let st = null;
        try {
          st = readyOrThrow(impl.className);
        } catch (err) {
          if (!(err instanceof Unsupported)) throw err;
        }
        readyByImpl.set(impl.className, st);
        if (st) readyCount += 1;
      }
      if (!readyCount) {
        // Any one impl gaining a module makes this site linkable, so wait on
        // the whole cone rather than picking one arbitrarily.
        throw new Unsupported(`invoke ${owner}.${name} no ready impl`,
          [...resolved.impls.values()].map((impl) => implKey(impl.className)));
      }
      dispatch = new Map();
      for (const [runtimeClass, impl] of resolved.targets) {
        const st = readyByImpl.get(impl.className);
        if (st) dispatch.set(runtimeClass, st);
      }
    }
    // java arg slot -> position in the wasm arg list (receiver = slot 0)
    const argPosBySlot = new Map([[0, 0]]);
    let slot = 1;
    params.forEach((p, i) => { argPosBySlot.set(slot, i + 1); slot += (p === 'J' || p === 'D') ? 2 : 1; });
    const underCount = underTypes.length;
    // The caller's typed slots ride as leading params (same fused-spill
    // scheme as checkcastImport): the fast path pays a single JS crossing,
    // and every deopt path writes the slots into frame.locals before the
    // interpreter resumes. Throw paths (NPE) unwind past this frame —
    // compiled blocks sit outside live handler ranges — so stale locals
    // are unobservable there.
    const callerSlots = this.paramSlots.slice();
    const slotCount = callerSlots.length;
    const wParams = [
      ...callerSlots.map((s) => this.slotTypes.get(s)),
      ...underTypes, T.ref, ...params.map(descToWasm),
    ];
    const results = ret === 'V' ? [] : [descToWasm(ret)];
    const key = `${owner}.${name}${descriptor}`;
    const callerBox = this.box;
    const resumePc = itemIndex + 1;
    const scratchFrames = new Map(); // target st -> reusable deopt frame
    const stats = this.siteStatsFor(`vcall_${owner}.${name}@${this.className}.${this.method.name}:${itemIndex}`);
    // Union of the targets known when the caller is emitted. A late target
    // may be installed only when this already-emitted kill set covers all of
    // its writes (`null` means every cache is killed).
    let writes = new Set();
    for (const st of direct ? [direct] : new Set(dispatch.values())) {
      const sub = this.wasmJit.instanceWriteSummary(st.targetClassName, name, descriptor);
      if (sub === null) { writes = null; break; }
      for (const k of sub) writes.add(k);
    }
    const lateMissEpoch = new Map();
    const spillCallerSlots = (all) => {
      const locals = callerBox.frame.locals;
      for (let i = 0; i < slotCount; i++) locals[callerSlots[i]] = all[i];
    };
    const fn = (...all) => {
      if (stats) stats.calls += 1;
      const args = all.slice(slotCount + underCount);
      const receiver = args[0];
      if (receiver === null || receiver === undefined) {
        throw NPE(`invoke ${key} on null`);
      }
      const receiverClass = runtimeClassName(receiver);
      let calleeSt = direct || dispatch.get(receiverClass);
      if (!calleeSt && dispatch) {
        // Do not redo an expensive failed resolution until either the class
        // world or the set of ready compiled callees changes.
        const epoch = `${this.jvm.classEpoch || 0}:${this.wasmJit.compileEpoch}`;
        if (lateMissEpoch.get(receiverClass) !== epoch) {
          lateMissEpoch.set(receiverClass, epoch);
          calleeSt = this.wasmJit.resolveLateInstanceTarget(
            owner, name, descriptor, receiverClass, writes,
          );
          if (calleeSt) {
            dispatch.set(receiverClass, calleeSt);
            lateMissEpoch.delete(receiverClass);
            if (stats) stats.lateTargets += 1;
          }
        }
      }
      // A captured guard-elided module must re-check its baked class world
      // before running; invalidation drops to the deopt path below.
      if (calleeSt && !this.wasmJit.revalidateNestedCallee(calleeSt)) {
        calleeSt = null;
      }
      if (!calleeSt) {
        // A new target that is unavailable or has writes not covered by the
        // caller's baked cache kills takes the original deopt path before
        // any callee side effect.
        if (stats) stats.deopts += 1;
        spillCallerSlots(all);
        callerBox.frame.pc = itemIndex;
        for (let i = 0; i < underCount; i++) callerBox.frame.stack.push(all[slotCount + i]);
        for (const v of args) callerBox.frame.stack.push(v);
        throw new NestedDeopt([]);
      }
      const calleeMod = calleeSt.callee || calleeSt;
      const meta = calleeMod.meta;
      // usedEh forces a scratch frame: a -3 exit spills into it and the
      // exception dispatches inside the callee's own table below
      const partial = !meta.fullyCompiled || meta.deoptableCalls > 0 || meta.usedEh;
      if (stats && partial) stats.scratch += 1;
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
      let frame;
      if (partial) {
        calleeSt.nestedCalls = (calleeSt.nestedCalls || 0) + 1;
        const scratch = scratchFrames.get(calleeSt);
        if (scratch && !scratch.inUse) {
          frame = scratch;
          frame.pc = 0;
        } else {
          frame = new Frame(calleeSt.method);
          frame.className = calleeSt.targetClassName;
          if (!scratch) scratchFrames.set(calleeSt, frame);
        }
        frame.inUse = true;
      } else {
        frame = { locals: [] }; // junk sink should a fuel exit ever spill
      }
      meta.box.frame = frame;
      meta.box.ret = undefined;
      let status;
      try {
        status = calleeMod.run(...full);
      } catch (err) {
        if (partial && err instanceof NestedDeopt) {
          if (stats) stats.deopts += 1;
          err.frames.push(frame);
          if (frame === scratchFrames.get(calleeSt)) scratchFrames.delete(calleeSt);
          spillCallerSlots(all);
          callerBox.frame.pc = resumePc;
          // the interpreter resumes mid-expression: the values under the
          // call's arguments must be back on the caller's operand stack
          for (let i = 0; i < underCount; i++) callerBox.frame.stack.push(all[slotCount + i]);
        }
        throw err;
      } finally {
        if (partial) frame.inUse = false;
        meta.box.frame = savedFrame;
      }
      if (status === -3) {
        // the callee caught a guest exception in wasm; its spill wrote the
        // throw-point locals into the scratch frame — dispatch there, or
        // propagate when its own table has no handler
        const exn = meta.box.pendingException;
        meta.box.pendingException = null;
        if (this.jvm.dispatchExceptionInFrame(frame, exn, meta.box.throwPc)) {
          if (stats) stats.deopts += 1;
          if (frame === scratchFrames.get(calleeSt)) scratchFrames.delete(calleeSt);
          spillCallerSlots(all);
          callerBox.frame.pc = resumePc;
          for (let i = 0; i < underCount; i++) callerBox.frame.stack.push(all[slotCount + i]);
          throw new NestedDeopt([frame]);
        }
        throw exn;
      }
      if (status !== -1) {
        if (!partial) throw new Error(`wasmjit: nested callee ${key} exited at ${status}`);
        if (stats) stats.deopts += 1;
        frame.pc = status;
        if (frame === scratchFrames.get(calleeSt)) scratchFrames.delete(calleeSt);
        spillCallerSlots(all);
        callerBox.frame.pc = resumePc;
        for (let i = 0; i < underCount; i++) callerBox.frame.stack.push(all[slotCount + i]);
        calleeSt.nestedDeopts = (calleeSt.nestedDeopts || 0) + 1;
        if (calleeSt.nestedDeopts > 256 &&
            calleeSt.nestedDeopts * 4 > calleeSt.nestedCalls) {
          calleeSt.linkVetoed = true;
        }
        // a structured callee's own call-site deopt parks deeper frames on
        // its box; they sit below the callee frame, innermost first
        const deeper = meta.box.pendingFrames;
        meta.box.pendingFrames = null;
        throw new NestedDeopt(deeper ? [...deeper, frame] : [frame]);
      }
      return meta.box.ret;
    };
    // Direct wasm->wasm fast path for the single-ready-target shape. The
    // generic import above stays as the complete slow path — null receivers,
    // unmatched classes, and late targets all fall back to it — so dispatch
    // soundness is unchanged. The fast path adds only the never-exits
    // invariant already accepted for static links: a fuel exit of a
    // fully-compiled callee becomes a wasm trap on this already-fatal path.
    let directLink = null;
    if (this.wasmJit.directInstanceLinkEnabled && !this.ehMethod) {
      const targets = direct ? [direct] : [...new Set(dispatch.values())];
      const st = targets.length === 1 ? targets[0] : null;
      const calleeMod = st && (st.callee || st);
      const calleeMeta = calleeMod && calleeMod.meta;
      // A guard-elided speculative callee can be raw-linked only through the
      // class-set guard: directClasses is a closed set verified against the
      // callee's baked picks at link time (revalidate now), and any class
      // loaded later misses the guard into the generic path. invokespecial's
      // bare null check admits future receiver classes, so it keeps the
      // bridge for speculative callees.
      const speculative = calleeMeta &&
        calleeMeta.specSites && calleeMeta.specSites.length > 0;
      const eligible = calleeMeta && calleeMeta.fullyCompiled &&
        !calleeMeta.usedEh && !(calleeMeta.deoptableCalls > 0) &&
        calleeMeta.runv && !st.linkVetoed &&
        (!speculative ||
          (!direct && this.wasmJit.revalidateNestedCallee(st)));
      let identity = false;
      if (eligible) {
        const expected = [{slot: 0, t: T.ref}];
        let expectedSlot = 1;
        for (const p of params) {
          expected.push({slot: expectedSlot, t: descToWasm(p)});
          expectedSlot += (p === 'J' || p === 'D') ? 2 : 1;
        }
        identity = calleeMeta.paramSlots.length === expected.length &&
          calleeMeta.paramSlots.every((p, i) => p.slot === expected[i].slot &&
            p.t === expected[i].t);
      }
      if (identity) {
        const directIdx = this.addImport(
          `dcall_${key}_${itemIndex}`.replace(/[^\w]/g, '_'),
          [T.ref, ...params.map(descToWasm)],
          ret === 'V' ? [T.i32] : [T.i32, descToWasm(ret)],
          calleeMeta.runv);
        let guardIdx;
        let specMono = false;
        if (!direct) {
          // A COMPLETE monomorphic cone needs no receiver-class guard at
          // all: every loaded receiver was verified to dispatch to the
          // single impl, the caller records the speculation, and the
          // in-wasm specok flag (zeroed synchronously on every class load,
          // re-armed by entry revalidation) closes the mid-run-load hole.
          // Only a null check remains on the fast path.
          if (resolvedCone && resolvedCone.complete &&
              resolvedCone.impls.size === 1) {
            specMono = true;
            const implClassName =
              [...resolvedCone.impls.values()][0].className;
            if (!this.specSites) this.specSites = [];
            this.specSites.push({
              owner, name, descriptor, guards: [implClassName],
            });
            this.usesSpecok = true;
          } else {
            // Every runtime class known to dispatch to the linked target
            // passes the guard; later-loaded classes fail it and take the
            // generic import's late-target/miss protocol.
            const directClasses = new Set();
            for (const [runtimeClass, targetSt] of dispatch) {
              if (targetSt === st) directClasses.add(runtimeClass);
            }
            guardIdx = this.addImport(
              `dguard_${key}_${itemIndex}`.replace(/[^\w]/g, '_'),
              [T.ref], [T.i32],
              (r) => (r !== null && r !== undefined &&
                directClasses.has(runtimeClassName(r))) ? 1 : 0);
          }
        }
        directLink = {
          directIdx, guardIdx, specMono,
          specokIdx: this.desc.ret === 'V' ? 0 : 1,
          retType: ret === 'V' ? null : descToWasm(ret),
        };
        this.directLinks = (this.directLinks || 0) + 1;
      }
    }
    // Resume pc and the patchable dispatch map live in one import per site.
    this.instanceSites = (this.instanceSites || 0) + 1;
    const importName = `vcall_${key}_${itemIndex}`.replace(/[^\w]/g, '_');
    return {
      argTypes: wParams.slice(slotCount + underCount),
      underTypes,
      writes,
      leadGets: callerSlots.map((s) => this.localOfSlot.get(s)),
      idx: this.addImport(importName, wParams, results, fn),
      directLink,
    };
  }

  // checkcast compiled as a per-site import: known classes resolve with the
  // synchronous hierarchy walk (matching the JS tier's tryCheckCastSync) and
  // throw the guest ClassCastException on failure; an unknown class deopts to
  // the interpreter at the checkcast, which can load classes asynchronously.
  // Handles both checkcast and instanceof: the hierarchy question and its memo
  // are identical, only the answer differs. checkcast yields the reference
  // (null passes) or throws CCE; instanceof yields 0/1 and never throws. They
  // are separated here because a cache-and-guard shape like
  // `if (x instanceof T) use((T) x)` demotes its whole block on the opcode the
  // compiler is missing, and demoting one block of a loop body costs the whole
  // method its module — measured on runTile, where `instanceof` in the inner
  // loop left a ready module at runs==exits, contributing nothing.
  checkcastImport(ins, itemIndex, underTypes, op = 'checkcast') {
    // Opt-in: compiling casts is correct (see wasmInstanceLink tests) but
    // measured net-negative on reference-workload — it unlocks tiny deoptable
    // callees whose per-call partial-protocol overhead exceeds interpreting
    // them. Revisit when a larger region can keep these operations in wasm.
    if (!this.wasmJit || !this.wasmJit.instanceLinkEnabled ||
        !this.wasmJit.checkcastEnabled) {
      throw new Unsupported(`op ${op}`);
    }
    const isTest = op === 'instanceof';
    const target = ins.arg;
    if (typeof target !== 'string') throw new Unsupported(`op ${op}`);
    const jvm = this.jvm;
    const callerBox = this.box;
    const underCount = underTypes.length;
    // The caller's typed slots ride along as leading params and reach
    // frame.locals only on the deopt path — the fast path pays a single
    // JS crossing (no spill_all) and a memo hit. A hierarchy verdict for a
    // loaded (source, target) pair is immutable, so the memo never expires;
    // a CCE unwinds past this frame (compiled blocks sit outside live
    // handler ranges), so stale locals cannot be observed on that path.
    const slots = this.paramSlots.slice();
    const slotCount = slots.length;
    const verdicts = new Map();
    const stats = this.siteStatsFor(`${isTest ? 'isof' : 'cast'}_${target}@${this.className}.${this.method.name}:${itemIndex}`);
    const fn = (...all) => {
      if (stats) stats.calls += 1;
      const ref = all[slotCount + underCount];
      // null is an instance of nothing, but casts fine.
      if (ref === null || ref === undefined) return isTest ? 0 : null;
      const source = runtimeClassName(ref);
      const memo = verdicts.get(source);
      if (memo === true) return isTest ? 1 : ref;
      if (memo === false && isTest) return 0;
      if (memo === undefined) {
        const sourceKnown = (typeof source === 'string' && source.startsWith('[')) ||
          jvm.classes[source] || jvm.jre[source];
        const targetKnown = target === 'java/lang/Object' || target.startsWith('[') ||
          jvm.classes[target] || jvm.jre[target];
        if (sourceKnown && targetKnown) {
          const ok = jvm.isInstanceOf(source, target);
          if (verdicts.size < 64) verdicts.set(source, ok);
          if (isTest) return ok ? 1 : 0;
          if (ok) return ref;
        } else {
          if (stats) stats.deopts += 1;
          const locals = callerBox.frame.locals;
          for (let i = 0; i < slotCount; i++) locals[slots[i]] = all[i];
          callerBox.frame.pc = itemIndex;
          for (let i = 0; i < underCount; i++) {
            callerBox.frame.stack.push(all[slotCount + i]);
          }
          callerBox.frame.stack.push(ref);
          throw new NestedDeopt([]);
        }
      }
      throw {
        type: 'java/lang/ClassCastException',
        message: `${source} cannot be cast to ${target}`,
      };
    };
    this.instanceSites = (this.instanceSites || 0) + 1;
    const importName = `${isTest ? 'isof' : 'cast'}_${target}_${itemIndex}`.replace(/[^\w]/g, '_');
    const slotTypes = slots.map((s) => this.slotTypes.get(s));
    const result = isTest ? T.i32 : T.ref;
    return {
      argTypes: [T.ref],
      result,
      underTypes,
      leadGets: slots.map((s) => this.localOfSlot.get(s)),
      idx: this.addImport(importName, [...slotTypes, ...underTypes, T.ref], [result], fn),
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
    const excTable = codeAttr.code.exceptionTable || [];
    const liveRanges = liveExceptionRanges(this.jvm, codeAttr.code, this.labelIndex);
    // EH (mirrors the structured tier): one try_table/catch_all around the
    // dispatcher body plus a per-block current-pc local. Must be decided
    // before the first addImport so every import gets the recording wrapper.
    const env = (typeof process !== 'undefined' && process.env) || {};
    this.ehMethod = env.JVM_WASM_EH !== '0' &&
      supportsWasmTryTable() && liveRanges.length > 0;
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
    // Split blocks at live-range boundaries: EH dispatch uses the block's
    // start pc for every op in it, which requires no block to straddle a
    // range edge. javac ranges are statement-aligned, so these splits land
    // on empty-stack boundaries.
    if (this.ehMethod) {
      for (const [rs, re] of liveRanges) {
        leaders.add(rs);
        if (re < this.items.length) leaders.add(re);
      }
      // handler entries become blocks so the catch arm can dispatch to them
      // in-module (their entry stack is seeded [exn] below)
      for (const e of excTable) {
        const idx = this.labelIndex.get(`L${e.handler_pc}`);
        if (idx !== undefined) leaders.add(idx);
      }
    }
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
    this.fieldCaches = new Map(); // cacheKey -> {valLocal, filledLocal, ...}
    this.refScratch = undefined;

    // With EH the whole dispatcher loop runs under try_table/catch_all and a throw
    // dispatches at the current block's start pc. That pc stands in for every
    // op in the block, which is only sound when the block sits entirely
    // inside (or entirely outside) each live range — blocks STRADDLING a
    // live-range boundary would catch or miss handlers depending on which op
    // threw, so they stay interpreted. Without EH every intersecting block
    // demotes as before.
    const rangeDemoted = new Set();
    this.ehBlockPc = new Map();
    for (let b = 0; b < N; b++) {
      const from = this.blockStarts[b];
      const to = b + 1 < N ? this.blockStarts[b + 1] : this.items.length;
      let straddles = false;
      let intersects = false;
      for (const [rs, re] of liveRanges) {
        if (from < re && to > rs) {
          intersects = true;
          if (!(rs <= from && to <= re)) straddles = true;
        }
      }
      if (!this.ehMethod) {
        if (intersects) rangeDemoted.add(b);
        continue;
      }
      const pc = this.pcOfBlock(b);
      // covered blocks need a real pc to reach their handler; uncovered
      // blocks without one dispatch at -1 (matches no range — the same
      // propagate-out the stale-pc unwind gave them before EH)
      if (straddles || (intersects && pc === null)) rangeDemoted.add(b);
      else this.ehBlockPc.set(b, pc === null ? -1 : pc);
    }

    // pass 1 (dry run): fix each block's entry stack shape by propagating
    // along CFG edges from the method entry; blocks unreached by propagation
    // (dead code, handler-only targets) are assumed empty. Emitted code and
    // local allocations from this pass are discarded.
    this.entryStacks = new Map([[0, []]]);
    if (this.ehMethod) {
      // JVM handler semantics: operand stack discarded, [exception] pushed.
      // Seed handler blocks with a single ref so both passes compile them
      // against the real entry shape; the catch arm below fills the depth-0
      // ref carry local before re-dispatching.
      for (const e of excTable) {
        const idx = this.labelIndex.get(`L${e.handler_pc}`);
        const hb = idx !== undefined ? this.blockOfItem.get(idx) : undefined;
        if (hb !== undefined && hb !== 0 && !this.entryStacks.has(hb)) {
          this.entryStacks.set(hb, [T.ref]);
        }
      }
    }
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
      // Reallocate every cache entry pass 1 discovered so pass-2 kill sites
      // cover fills that compile later in block order (pass 2 can only see a
      // subset of pass 1's sites — demotions remove, never add).
      const discovered = this.fieldCaches;
      this.fieldCaches = new Map();
      this.refScratch = undefined;
      for (const [cacheKey, entry] of discovered) {
        this.fieldCacheFor(cacheKey, entry.t, entry.killKey, entry.slot, entry.kind);
      }
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
        for (const name of blockedNames(err)) this.demoteBlockers.add(name);
        blockBodies[b] = this.exitStub(b);
      }
    }
    if (!this.supportedBlocks.size) throw new Unsupported('no supported blocks');
    const normalReachable = this.normalReachableBlocks(N);
    this.normalFlowFullyCompiled = [...normalReachable]
      .every((b) => this.supportedBlocks.has(b));
    // Normal-flow items NOT covered by supported blocks: compile()'s tier
    // preference compares coverage GAPS across tiers. Gaps, not covered
    // counts: the tiers partition and expand items differently, so covered
    // totals are incomparable, but "how much normal flow falls back to the
    // interpreter" is — and a gap-free structured module must always win.
    this.uncoveredItems = 0;
    // Which opcodes the gap is made of. "partial" is not actionable on its
    // own; "partial because of these three opcodes" is.
    this.uncoveredOpcodes = new Map();
    for (const b of normalReachable) {
      if (this.supportedBlocks.has(b)) continue;
      const end = b + 1 < N ? this.blockStarts[b + 1] : this.items.length;
      for (let i = this.blockStarts[b]; i < end; i++) {
        if (!(this.items[i] && this.items[i].instruction)) continue;
        this.uncoveredItems += 1;
        const op = getOp(this.items[i].instruction) || '?';
        this.uncoveredOpcodes.set(op, (this.uncoveredOpcodes.get(op) || 0) + 1);
      }
    }

    // external entry (invocation, OSR, resume-after-exit) is only sound at a
    // supported block whose inferred entry stack is empty
    this.externalEntry = new Set(
      [...this.supportedBlocks].filter((b) => (this.entryStacks.get(b) || []).length === 0));
    if (!this.externalEntry.size) throw new Unsupported('no supported blocks');

    // function body: dispatcher loop (fuel is checked per block prologue)
    const body = [];
    if (this.ehMethod) {
      // Every block prologue stamps its start pc into curPcLocal; the
      // try_table/catch_all INSIDE the dispatcher loop then dispatches any guest
      // exception at that pc — to a compiled handler block by re-entering
      // the br_table (the throw→handler→continue cycle never leaves wasm),
      // or to the interpreter via -3 (slot locals are continuously live in
      // this tier, so the spill sees throw-point state; boxed slots live in
      // frame.locals already and must not be spilled).
      this.curPcLocal = this.nextLocal++;
      this.declared.push(T.i32);
      for (let b = 0; b < N; b++) {
        const pc = this.ehBlockPc.has(b) ? this.ehBlockPc.get(b) : -1;
        blockBodies[b] = [
          OP.i32_const, ...sleb(pc), OP.local_set, ...uleb(this.curPcLocal),
          ...blockBodies[b],
        ];
      }
    }
    body.push(OP.loop, 0x40);
    if (this.ehMethod) {
      // try_table handlers branch to an enclosing label. Normal completion
      // skips the handler through $done; an exception branches through
      // $catch and falls into the handler after that inner block.
      body.push(
        OP.block, 0x40, // $done
        OP.block, 0x40, // $catch
        OP.try_table, 0x40,
        ...uleb(1), OP.catch_all_clause, ...uleb(0),
      );
    }
    for (let i = 0; i < N; i++) body.push(OP.block, 0x40);
    body.push(OP.local_get, ...uleb(this.blkLocal));
    body.push(OP.br_table, ...uleb(N));
    for (let i = 0; i < N; i++) body.push(...uleb(i));
    body.push(...uleb(N - 1));
    for (let b = 0; b < N; b++) {
      body.push(OP.end);
      body.push(...blockBodies[b]);
    }
    if (this.ehMethod) {
      const box = this.box;
      const jvm = this.jvm;
      // First-matching table entry decides, exactly like the interpreter's
      // search; blk is -1 when that handler block did not compile, which
      // falls back to the precise -3 interpreter dispatch (never falls
      // through to a LATER entry — order is observable).
      const ehTargets = excTable.map((e) => {
        const idx = this.labelIndex.get(`L${e.handler_pc}`);
        const hb = idx !== undefined ? this.blockOfItem.get(idx) : undefined;
        return {
          start_pc: e.start_pc, end_pc: e.end_pc, catch_type: e.catch_type,
          blk: hb !== undefined && this.supportedBlocks.has(hb) ? hb : -1,
        };
      });
      const ehTargetIdx = this.addImport('eh_target', [T.i32], [T.i32], (pc) => {
        const exn = box.pendingException;
        for (const e of ehTargets) {
          if (pc >= e.start_pc && pc < e.end_pc &&
              (e.catch_type === 'any' || jvm.isInstanceOf(exn.type, e.catch_type))) {
            return e.blk;
          }
        }
        return -1;
      });
      const ehTakeIdx = this.addImport('eh_take', [], [T.ref], () => {
        const e = box.pendingException;
        box.pendingException = null;
        return e;
      });
      const ehTgt = this.nextLocal++;
      this.declared.push(T.i32);
      body.push(OP.end); // try_table
      body.push(OP.br, ...uleb(1)); // normal completion -> $done
      body.push(OP.end); // $catch; caught exceptions enter the handler here
      body.push(OP.call, ...uleb(this.addImport('eh_pending', [], [T.i32],
        () => (box.pendingException !== null ? 1 : 0))));
      body.push(OP.if, 0x40);
      body.push(OP.local_get, ...uleb(this.curPcLocal));
      body.push(OP.call, ...uleb(ehTargetIdx));
      body.push(OP.local_tee, ...uleb(ehTgt), OP.i32_const, ...sleb(0), OP.i32_ge_s);
      body.push(OP.if, 0x40);
      // in-module dispatch: exception into the depth-0 ref carry (the
      // handler block's seeded entry stack), target into blk, loop again
      body.push(OP.call, ...uleb(ehTakeIdx));
      body.push(OP.local_set, ...uleb(this.stackLocalFor(0, T.ref)));
      body.push(OP.local_get, ...uleb(ehTgt), OP.local_set, ...uleb(this.blkLocal));
      body.push(OP.br, ...uleb(3)); // 0=this if, 1=outer if, 2=$done, 3=loop
      body.push(OP.end);
      body.push(...this.spillSeq());
      body.push(OP.local_get, ...uleb(this.curPcLocal));
      body.push(OP.call, ...uleb(this.addImport('eh_pc', [T.i32], [],
        (pc) => { box.throwPc = pc; })));
      body.push(OP.i32_const, ...sleb(-3), OP.return);
      body.push(OP.end);
      body.push(OP.call, ...uleb(this.addImport('eh_rethrow', [], [],
        () => { throw box.lastThrown; })));
      body.push(OP.unreachable);
      body.push(OP.end);        // $done
      body.push(OP.unreachable);
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

  // cumulative per-site runtime counters (debug only); keyed by site name so
  // recompiles keep accumulating into the same object
  siteStatsFor(key) {
    const map = this.wasmJit && this.wasmJit.siteStats;
    if (!map) return null;
    let stats = map.get(key);
    if (!stats) {
      stats = { calls: 0, deopts: 0, scratch: 0, lateTargets: 0 };
      map.set(key, stats);
    }
    return stats;
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

  // Call an import that may deopt while values sit UNDER its arguments on the
  // wasm stack. The unders are copied into scratch locals, restored in place,
  // and passed to the import a second time as leading parameters so a deopt
  // path can rebuild the interpreter operand stack. Stack shape afterwards:
  // [unders..., result?] — identical to a plain call.
  callSeqWithUnders(idx, argTypes, underTypes, leadGets = []) {
    const seq = [];
    const argScr = argTypes.map((t) => this.scratch(t));
    for (let i = argTypes.length - 1; i >= 0; i--) seq.push(OP.local_set, ...uleb(argScr[i]));
    const undScr = underTypes.map((t) => this.scratch(t));
    for (let j = underTypes.length - 1; j >= 0; j--) seq.push(OP.local_set, ...uleb(undScr[j]));
    for (let j = 0; j < underTypes.length; j++) seq.push(OP.local_get, ...uleb(undScr[j]));
    // leading params (e.g. the caller's typed slots for a fused deopt spill)
    for (const l of leadGets) seq.push(OP.local_get, ...uleb(l));
    for (let j = 0; j < underTypes.length; j++) seq.push(OP.local_get, ...uleb(undScr[j]));
    for (let i = 0; i < argTypes.length; i++) seq.push(OP.local_get, ...uleb(argScr[i]));
    seq.push(OP.call, ...uleb(idx));
    return seq;
  }

  // Guarded direct wasm->wasm instance call. Receiver and arguments are
  // stashed once; a matching receiver calls the callee's runv import with no
  // JS on the path, everything else rebuilds the generic dispatch import's
  // exact operand layout. Stack shape afterwards matches callSeqWithUnders:
  // [unders..., result?].
  directInstanceCallSeq(bound) {
    const { argTypes, underTypes, leadGets, directLink } = bound;
    const seq = [];
    const argScr = argTypes.map((t) => this.scratch(t));
    for (let i = argTypes.length - 1; i >= 0; i--) seq.push(OP.local_set, ...uleb(argScr[i]));
    const undScr = underTypes.map((t) => this.scratch(t));
    for (let j = underTypes.length - 1; j >= 0; j--) seq.push(OP.local_set, ...uleb(undScr[j]));
    for (let j = 0; j < underTypes.length; j++) seq.push(OP.local_get, ...uleb(undScr[j]));
    if (directLink.guardIdx !== undefined) {
      seq.push(OP.local_get, ...uleb(argScr[0]), OP.call, ...uleb(directLink.guardIdx));
    } else {
      // invokespecial is statically bound: the only guard is non-null.
      // Speculative monomorphic links add the in-wasm specok flag (zeroed
      // on every class load, re-armed by entry revalidation) — no JS on
      // the guard path.
      seq.push(OP.local_get, ...uleb(argScr[0]), OP.ref_is_null, OP.i32_eqz);
      if (directLink.specMono) {
        seq.push(OP.global_get, ...uleb(directLink.specokIdx), OP.i32_and);
      }
    }
    seq.push(OP.if, directLink.retType === null ? 0x40 : directLink.retType);
    for (let i = 0; i < argScr.length; i++) seq.push(OP.local_get, ...uleb(argScr[i]));
    seq.push(OP.call, ...uleb(directLink.directIdx));
    if (directLink.retType !== null) {
      const sv = this.scratch(directLink.retType);
      seq.push(OP.local_set, ...uleb(sv));
      seq.push(OP.i32_const, ...sleb(-1), OP.i32_ne,
        OP.if, 0x40, OP.unreachable, OP.end);
      seq.push(OP.local_get, ...uleb(sv));
    } else {
      seq.push(OP.i32_const, ...sleb(-1), OP.i32_ne,
        OP.if, 0x40, OP.unreachable, OP.end);
    }
    seq.push(OP.else);
    for (const l of leadGets) seq.push(OP.local_get, ...uleb(l));
    for (let j = 0; j < underTypes.length; j++) seq.push(OP.local_get, ...uleb(undScr[j]));
    for (let i = 0; i < argScr.length; i++) seq.push(OP.local_get, ...uleb(argScr[i]));
    seq.push(OP.call, ...uleb(bound.idx));
    seq.push(OP.end);
    return seq;
  }

  spillSeq() {
    if (!this.paramSlots.length) return [];
    // One import call spilling every typed slot at once: exit stubs are
    // replicated into every block's fuel prologue, so per-slot calls cost
    // both boundary crossings and module bytes.
    const slots = this.paramSlots.slice();
    const box = this.box;
    const idx = this.addImport('spill_all', slots.map((s) => this.slotTypes.get(s)), [],
      (...values) => {
        const locals = box.frame.locals;
        for (let i = 0; i < slots.length; i++) locals[slots[i]] = values[i];
      });
    const seq = [];
    for (const s of slots) seq.push(OP.local_get, ...uleb(this.localOfSlot.get(s)));
    seq.push(OP.call, ...uleb(idx));
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
    // Under EH, $done, $catch, and try_table sit between the loop label and
    // the block nest. Branches that re-enter the dispatcher cross all three.
    const depthToTop = N - 1 - b + (this.ehMethod ? 3 : 0);
    const code = [];
    const stack = (this.entryStacks.get(b) || []).slice(); // wasm types, bottom-up
    // provenance: which local slot (if any) a stacked value was loaded from —
    // carried values entering the block have unknown origin
    const prov = stack.map(() => null);
    const emit = (...bytes) => code.push(...bytes);
    const push = (t, p = null) => { stack.push(t); prov.push(p); };
    const pop = (expected) => {
      if (!stack.length) throw new Unsupported('stack underflow (value flows across block boundary)');
      prov.pop();
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
          emit(OP.local_get, ...uleb(localOf(s)));
          push(this.slotTypes.get(s), op[0] === 'a' ? { slot: s } : null);
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
        emit(...this.killSeqWhere((entry) => entry.slot === s));
        for (let d = 0; d < prov.length; d++) {
          if (prov[d] && prov[d].slot === s) prov[d] = null;
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
        emit(OP.call, ...uleb(this.importIndexByName.get(arrayLoadImportName(this, op, t))));
        push(t);
      } else if (op in ARRAY_STORE) {
        const t = ARRAY_STORE[op];
        pop(); pop(T.i32); pop(T.ref);
        const storeImport = this.wasmJit.typedArrayStoresEnabled
          ? `aset_${op}` : `aset_${sig(t)}`;
        emit(OP.call, ...uleb(this.importIndexByName.get(storeImport)));
      } else if (op === 'arraylength') {
        pop(T.ref);
        emit(OP.call, ...uleb(this.importIndexByName.get('alen')));
        push(T.i32);
      } else if (op === 'newarray') {
        // allocation imports run no guest code (`new` compiles only for
        // already-initialized classes) and cannot deopt — no spill needed
        pop(T.i32);
        emit(OP.call, ...uleb(addNewArrayImport(this, this.jvm, ins.arg)));
        push(T.ref);
      } else if (op === 'anewarray') {
        pop(T.i32);
        emit(OP.call, ...uleb(addANewArrayImport(this, this.jvm, ins.arg)));
        push(T.ref);
      } else if (op === 'new') {
        emit(OP.call, ...uleb(addNewImport(this, this.jvm, ins.arg)));
        push(T.ref);
      } else if (op === 'getfield' || op === 'getstatic') {
        const st = op === 'getstatic';
        const { t, idx, name } = this.fieldImports(ins, st, true);
        const [, , [fieldName, descriptor]] = ins.arg;
        const killKey = `${fieldName}:${descriptor}`;
        const caching = !this.wasmJit || this.wasmJit.fieldCacheEnabled !== false;
        if (st) {
          if (caching) {
            const entry = this.fieldCacheFor(`s|${name}`, t, killKey, undefined, 's');
            emit(...this.cachedReadSeq(entry, [OP.call, ...uleb(idx)]));
          } else {
            emit(OP.call, ...uleb(idx));
          }
          push(t);
        } else {
          const receiver = prov[prov.length - 1];
          pop(T.ref);
          if (caching && receiver && receiver.slot !== undefined) {
            const entry = this.fieldCacheFor(`f|${receiver.slot}|${name}`, t, killKey, receiver.slot, 'f');
            const rs = this.refScratchLocal();
            // cached path skips the null check: a filled flag proves the same
            // slot's object already loaded this field successfully this run
            emit(OP.local_set, ...uleb(rs),
              ...this.cachedReadSeq(entry, [OP.local_get, ...uleb(rs), OP.call, ...uleb(idx)]));
          } else {
            emit(OP.call, ...uleb(idx));
          }
          push(t);
        }
      } else if (op === 'putfield' || op === 'putstatic') {
        const st = op === 'putstatic';
        const { idx } = this.fieldImports(ins, st, false);
        const [, , [fieldName, descriptor]] = ins.arg;
        const killKey = `${fieldName}:${descriptor}`;
        pop(); if (!st) pop(T.ref);
        emit(OP.call, ...uleb(idx));
        emit(...this.killSeqWhere((entry) =>
          entry.kind === (st ? 's' : 'f') && entry.killKey === killKey));
      } else if (op === 'invokestatic') {
        let bound;
        let writes = EMPTY_WRITE_SET; // Math/time intrinsics write nothing
        try {
          bound = this.mathIntrinsic(ins);
        } catch (err) {
          if (!(err instanceof Unsupported)) throw err;
          try {
            bound = addTimeImport(this, this.jvm, ins);
          } catch (err2) {
            if (!(err2 instanceof Unsupported)) throw err2;
            const pcount = parseMethodDescriptor(ins.arg[2][1]).params.length;
            if (stack.length < pcount) throw new Unsupported('invokestatic stack underflow');
            bound = this.compiledCallee(ins, i, stack.slice(0, stack.length - pcount));
            const [, calleeClass, [calleeName, calleeDesc]] = ins.arg;
            writes = this.wasmJit
              ? this.wasmJit.staticWriteSummary(calleeClass, calleeName, calleeDesc)
              : null;
          }
        }
        const boundArgTypes = bound.argTypes || bound.params;
        const boundUnders = bound.underTypes || [];
        for (let k = 0; k < boundArgTypes.length; k++) pop();
        // a partial callee can deopt: the caller's typed slots must already
        // be in frame.locals so the interpreter can resume after the invoke
        if (bound.partial) emit(...this.spillSeq());
        if (boundUnders.length) {
          emit(...this.callSeqWithUnders(bound.idx, boundArgTypes, boundUnders));
        } else {
          emit(OP.call, ...uleb(bound.idx));
          if (bound.direct) {
            // runv returned [status, value]; verify the never-exits
            // invariant in wasm and leave only the value on the stack.
            if (bound.retType) {
              const sv = this.scratch(bound.retType);
              emit(OP.local_set, ...uleb(sv));
              emit(OP.i32_const, ...sleb(-1), OP.i32_ne,
                OP.if, 0x40, OP.unreachable, OP.end);
              emit(OP.local_get, ...uleb(sv));
            } else {
              emit(OP.i32_const, ...sleb(-1), OP.i32_ne,
                OP.if, 0x40, OP.unreachable, OP.end);
            }
          }
        }
        // kill only the field caches the callee may transitively write; an
        // unknowable callee (null summary) may put any field or static
        if (writes === null) emit(...this.killSeqWhere(() => true));
        else if (writes.size) emit(...this.killSeqWhere((entry) => writes.has(entry.killKey)));
        const retC = parseMethodDescriptor(ins.arg[2][1]).ret;
        if (retC !== 'V') push(descToWasm(retC));
      } else if (op === 'invokespecial' && ins.arg[1] === 'java/lang/Object' &&
          ins.arg[2][0] === '<init>' && ins.arg[2][1] === '()V') {
        // java/lang/Object.<init> is empty (a no-op JRE stub here); the
        // receiver of a super()/new Object() call is never null
        if (!stack.length) throw new Unsupported('invokespecial underflow');
        pop();
        emit(OP.drop);
      } else if (op === 'invokevirtual' || op === 'invokeinterface' || op === 'invokespecial') {
        const argCount = parseMethodDescriptor(ins.arg[2][1]).params.length + 1;
        if (stack.length < argCount) throw new Unsupported(`${op} stack underflow`);
        const bound = this.compiledInstanceCallee(ins, i, stack.slice(0, stack.length - argCount), op);
        for (let k = 0; k < argCount; k++) pop();
        // every instance site can deopt (map miss or partial target); the
        // caller's typed slots ride as leading import params and reach
        // frame.locals only on the deopt paths
        if (bound.directLink) {
          emit(...this.directInstanceCallSeq(bound));
        } else {
          emit(...this.callSeqWithUnders(bound.idx, bound.argTypes, bound.underTypes,
            bound.leadGets));
        }
        if (bound.writes === null) emit(...this.killSeqWhere(() => true));
        else if (bound.writes.size) {
          emit(...this.killSeqWhere((entry) => bound.writes.has(entry.killKey)));
        }
        const retC = parseMethodDescriptor(ins.arg[2][1]).ret;
        if (retC !== 'V') push(descToWasm(retC));
      } else if (op === 'checkcast' || op === 'instanceof') {
        if (!stack.length) throw new Unsupported(`${op} on empty stack`);
        const bound = this.checkcastImport(ins, i, stack.slice(0, stack.length - 1), op);
        pop(T.ref);
        emit(...this.callSeqWithUnders(bound.idx, bound.argTypes, bound.underTypes,
          bound.leadGets));
        push(bound.result);
      } else if (op === 'pop') { pop(); emit(OP.drop); }
      else if (op === 'pop2') {
        const t = pop(); emit(OP.drop);
        if (!CAT2.has(t)) { pop(); emit(OP.drop); }
      } else if (op === 'dup') {
        const t = stack[stack.length - 1];
        if (t === undefined) throw new Unsupported('dup on empty stack');
        const s = this.scratch(t);
        emit(OP.local_tee, ...uleb(s), OP.local_get, ...uleb(s));
        push(t, prov[prov.length - 1]);
      } else if (op === 'dup2') {
        const t1 = stack[stack.length - 1];
        if (t1 === undefined) throw new Unsupported('dup2 on empty stack');
        if (CAT2.has(t1)) {
          const s = this.scratch(t1);
          emit(OP.local_tee, ...uleb(s), OP.local_get, ...uleb(s));
          push(t1, prov[prov.length - 1]);
        } else {
          const t2 = stack[stack.length - 2];
          if (t2 === undefined) throw new Unsupported('dup2 underflow');
          const p1 = prov[prov.length - 1]; const p2 = prov[prov.length - 2];
          const s1 = this.scratch(t1); const s2 = this.scratch(t2);
          emit(OP.local_set, ...uleb(s1), OP.local_set, ...uleb(s2));
          emit(OP.local_get, ...uleb(s2), OP.local_get, ...uleb(s1));
          emit(OP.local_get, ...uleb(s2), OP.local_get, ...uleb(s1));
          push(t2, p2); push(t1, p1);
        }
      } else if (op === 'dup_x1') {
        const p1 = prov[prov.length - 1]; const p2 = prov[prov.length - 2];
        const t1 = pop(); const t2 = pop();
        const s1 = this.scratch(t1); const s2 = this.scratch(t2);
        emit(OP.local_set, ...uleb(s1), OP.local_set, ...uleb(s2));
        emit(OP.local_get, ...uleb(s1), OP.local_get, ...uleb(s2), OP.local_get, ...uleb(s1));
        push(t1, p1); push(t2, p2); push(t1, p1);
      } else if (op === 'swap') {
        const p1 = prov[prov.length - 1]; const p2 = prov[prov.length - 2];
        const t1 = pop(); const t2 = pop();
        const s1 = this.scratch(t1); const s2 = this.scratch(t2);
        emit(OP.local_set, ...uleb(s1), OP.local_set, ...uleb(s2));
        emit(OP.local_get, ...uleb(s1), OP.local_get, ...uleb(s2));
        push(t1, p1); push(t2, p2);
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
      } else if (op === 'ireturn' || op === 'freturn' || op === 'lreturn' ||
          op === 'dreturn' || op === 'areturn') {
        // The value leaves twice: through the exported retv global for
        // direct wasm->wasm callers (global.get is one instruction there),
        // and through the ret_* import for JS entries (the import call is
        // cheaper than a JS-side WebAssembly.Global.value read).
        const retImport = op === 'ireturn' ? 'ret_i' : op === 'freturn' ? 'ret_f'
          : op === 'lreturn' ? 'ret_l' : op === 'dreturn' ? 'ret_d' : 'ret_r';
        pop();
        emit(OP.global_set, ...uleb(0));
        emit(OP.global_get, ...uleb(0));
        emit(OP.call, ...uleb(this.importIndexByName.get(retImport)));
        emit(OP.i32_const, ...sleb(-1), OP.return);
        return code;
      } else if (op === 'return') {
        emit(OP.i32_const, ...sleb(-1), OP.return);
        return code;
      } else if (op === 'athrow') {
        // Throw the ref JS-side. EH methods dispatch through their try_table;
        // an unhandled throw records the exact bytecode item before unwinding
        // to the scheduler's ordinary Java-exception path.
        pop();
        emit(OP.call, ...uleb(this.addImport(`athrow_${i}`, [T.ref], [], (ref) => {
          if (!this.ehMethod && this.box.frame) this.box.frame.pc = i;
          if (ref === null || ref === undefined) {
            throw { type: 'java/lang/NullPointerException', message: null };
          }
          throw ref;
        })));
        emit(OP.unreachable);
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
    const profilerNameSection = wasmFunctionNameSection(
      mainIdx, wasmProfilerName(this.className, this.method));
    const retvType = this.desc.ret === 'V' ? null : descToWasm(this.desc.ret);
    const globalEntries = [
      ...(retvType ? [retvGlobalEntry(retvType)] : []),
      ...(this.usesSpecok ? [specokGlobalEntry()] : []),
    ];
    const globalSection = globalEntries.length
      ? section(6, [globalEntries.length, ...globalEntries.flat()]) : [];
    const retvName = [...'retv'].map((c) => c.charCodeAt(0));
    const specokName = [...'specok'].map((c) => c.charCodeAt(0));
    const paramOnly = mainParams.slice(0, mainParams.length - 2);
    const runvType = internType(paramOnly, retvType ? [T.i32, retvType] : [T.i32]);
    const runvBody = runvWrapperBody(paramOnly.length, mainIdx, retvType);
    const runvName = [...'runv'].map((c) => c.charCodeAt(0));
    const exportEntries = [
      [exportName.length, ...exportName, 0x00, ...uleb(mainIdx)],
      [runvName.length, ...runvName, 0x00, ...uleb(mainIdx + 1)],
      ...(retvType ? [[retvName.length, ...retvName, 0x03, 0]] : []),
      ...(this.usesSpecok
        ? [[specokName.length, ...specokName, 0x03, ...uleb(retvType ? 1 : 0)]]
        : []),
    ];

    const bytes = Uint8Array.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...section(1, vec(types)),
      ...section(2, vec(importEntries)),
      ...section(3, [2, ...uleb(mainType), ...uleb(runvType)]),
      ...globalSection,
      ...section(7, vec(exportEntries)),
      ...section(10, [2, ...uleb(funcBody.length), ...funcBody,
        ...uleb(runvBody.length), ...runvBody]),
      ...profilerNameSection,
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
      demoteBlockers: this.demoteBlockers,
      blockCount: this.blockStarts.length,
      fullyCompiled: this.supportedBlocks.size === this.blockStarts.length,
      normalFlowFullyCompiled: this.normalFlowFullyCompiled,
      // instance-dispatch sites can deopt at runtime (dispatch-map miss or
      // partial target), so callers must give this module a real frame and
      // the NestedDeopt protocol even when it is fully compiled
      deoptableCalls: this.instanceSites || 0,
      directLinks: this.directLinks || 0,
      // Speculative monomorphic direct links bake the compile-time cone;
      // prepare()'s gate revalidates these on entry and re-arms specok.
      specSites: this.specSites || [],
      speculations: 0,
      specEpoch: this.jvm.classEpoch || 0,
      boxedCount: this.boxedSlots.size,
      // EH modules return -3 with the spill aimed at the top frame — never
      // link them as nested callees (every link path checks this flag)
      usedEh: !!this.ehMethod,
      uncoveredItems: this.uncoveredItems,
      uncoveredOpcodes: this.uncoveredOpcodes,
      fieldCacheCount: this.fieldCaches.size,
    };
  }
}


class WasmJit {
  constructor(jvm, jit) {
    this.jvm = jvm;
    this.jit = jit;
    const env = (typeof process !== 'undefined' && process.env) || {};
    const browserDefault = typeof window !== 'undefined' && typeof document !== 'undefined';
    this.enabled = (env.JVM_WASM_JIT === '1' || browserDefault) && typeof WebAssembly !== 'undefined' &&
      !env.JVM_TRACE && env.JVM_PROFILE_HOT_METHODS !== '1';
    this.debug = env.JVM_DEBUG_WASMJIT === '1';
    this.traceMethodPattern = env.JVM_TRACE_WASM_METHOD || '';
    this.traceExitsOnly = env.JVM_TRACE_WASM_EXITS_ONLY === '1';
    this.traceResumePattern = env.JVM_WASM_TRACE_RESUME || '';
    this.noOsrMethods = env.JVM_WASM_NO_OSR_METHODS
      ? env.JVM_WASM_NO_OSR_METHODS.split(',').filter(Boolean) : null;
    this.fieldCacheEnabled = env.JVM_DISABLE_WASM_FIELD_CACHE !== '1';
    this.typedArrayStoresEnabled =
      env.JVM_DISABLE_WASM_TYPED_ARRAY_STORES !== '1';
    // Loop-bearing methods compile on first sight: warmup by invocation count
    // never fires for methods invoked once with a multi-minute loop (va.d).
    this.warmupThreshold = Number(env.JVM_WASM_JIT_WARMUP || 1);
    // A deferred compile is not retried (blockers unresolved) until this many
    // times its own failed wall time has elapsed. 0 disables the budget.
    this.failedCompileRetryFactor = env.JVM_WASM_FAILED_RETRY_FACTOR === undefined
      ? 20 : Number(env.JVM_WASM_FAILED_RETRY_FACTOR);
    // Only failures at least this expensive are budgeted: cheap ones are not
    // the waste this bounds, and synchronous retries must stay immediate.
    this.failedCompileRetryMinMs = env.JVM_WASM_FAILED_RETRY_MIN_MS === undefined
      ? 50 : Number(env.JVM_WASM_FAILED_RETRY_MIN_MS);
    this.retryBackoffMax = Math.max(1, Number(env.JVM_WASM_JIT_RETRY_BACKOFF_MAX || 4096));
    this.structuredEnabled = env.JVM_WASM_STRUCTURED === '1';
    this.instanceLinkEnabled = env.JVM_WASM_DEVIRT !== '0';
    // Direct wasm->wasm static links: eligible fully-compiled callees are
    // called through their runv export with no JS bridge on the path.
    this.directStaticLinkEnabled = env.JVM_WASM_DIRECT_STATIC_LINK === '1';
    // Direct wasm->wasm instance links: a monomorphic-in-practice site calls
    // its single ready fully-compiled target through runv behind an in-wasm
    // null check (invokespecial) or a one-import receiver-class guard
    // (invokevirtual/invokeinterface); every other receiver falls back to
    // the generic dispatch import.
    this.directInstanceLinkEnabled = env.JVM_WASM_DIRECT_INSTANCE_LINK === '1';
    this.lateInstanceTargetsEnabled = env.JVM_DISABLE_WASM_LATE_INSTANCE_TARGETS !== '1';
    this.checkcastEnabled = env.JVM_WASM_CHECKCAST === '1';
    // How many times a ready-but-partial module may be rebuilt after the class
    // world grows. Bounded because unbounded rebuilding is the "recompile
    // storm" that previously measured -1.4 to -2.4 fps; 0 disables it.
    this.depRecompileLimit = env.JVM_WASM_DEP_RECOMPILES === undefined
      ? 3 : Number(env.JVM_WASM_DEP_RECOMPILES);
    // Reference-return completeness test; see compile(). Opt-in: the
    // relaxation is reasoned-out but UNMEASURED, so it does not run by
    // default.
    this.relaxedRefReturn = env.JVM_WASM_RELAXED_REF_RETURN === '1';
    this.hierarchy = new ClassHierarchy(jvm);
    this.structuredCompiles = 0;
    this.runCount = 0;
    this.compileEpoch = 0;
    // debug-only runtime counters keyed by call-site import name
    this.siteStats = this.debug ? new Map() : null;
    if (this.siteStats && typeof process !== 'undefined' && process.on) {
      process.on('exit', () => {
        const rows = [...this.siteStats].sort((a, b) => b[1].calls - a[1].calls);
        for (const [site, s] of rows.slice(0, 40)) {
          console.error(`[wasmjit-sites] ${site}: calls=${s.calls} deopts=${s.deopts} ` +
            `scratch=${s.scratch}${s.lateTargets ? ` lateTargets=${s.lateTargets}` : ''}`);
        }
      });
    }
    // key -> {reasons, st}; strong refs are fine, this is a diagnostic mode.
    // JVM_WASM_CENSUS_FILE takes a path (%p expands to the pid) and implies
    // the mode, since a multi-thousand-method dump does not survive stderr.
    this.censusPath = env.JVM_WASM_CENSUS_FILE || '';
    this.census = (env.JVM_WASM_CENSUS === '1' || this.censusPath)
      ? new Map() : null;
    // The JS tier is consulted first and, when it wins, the wasm gate is
    // never asked — those methods are absent from the census entirely, so it
    // cannot say whether wasm COULD have covered them. Shadow mode asks
    // anyway, purely for accounting: the verdict is recorded and discarded,
    // nothing runs. It compiles modules that go unused, so it is slow and
    // strictly a diagnostic.
    this.censusShadow = !!this.census && env.JVM_WASM_CENSUS_SHADOW === '1';
    if (this.census && typeof process !== 'undefined' && process.on) {
      process.on('exit', () => this.dumpCensus());
    }
    // See probeFullCoverage(). Opt-in: it makes the gate compile modules the
    // JS tier might still win, which is a real up-front cost.
    this.preferFullCoverage = env.JVM_WASM_PREFER_FULL_COVERAGE === '1';
    // Bisection aid: restrict the preference to a comma-separated list of
    // `Class.name(desc)ret` keys, so one miscompiling method can be isolated
    // without disabling the whole policy.
    this.preferFullCoverageOnly = env.JVM_WASM_PREFER_FULL_COVERAGE_ONLY
      ? new Set(env.JVM_WASM_PREFER_FULL_COVERAGE_ONLY.split(','))
      : null;
    this.fullCoverage = new WeakMap(); // method -> settled boolean
    this.fullCoverageProbes = 0;
    this.fullCoverageWins = 0;
    this.state = new WeakMap(); // method -> {entries, status, run, meta, key, runs, exits, fuelExits}
    this.compiled = [];
    // Method key -> the compileEpoch at which it first reached `ready`. A
    // demotion can name a callee METHOD rather than a class (the callee had no
    // linkable module yet), and class readiness cannot see that change — the
    // owning class is typically long since initialized. The epoch (rather than
    // a plain set) is what lets a signature be asked "as of" a point in time:
    // a compile routinely makes its own callees ready while running, so
    // stamping readiness at the end would record a blocker as already cleared
    // and the rebuild it should have triggered would never fire. See
    // blockerSignature.
    this.keyReadyEpoch = new Map();
    this.writeSummaries = new Map(); // `cls.name(desc)` -> {keys: Set|null, epoch}
    this.lateInstanceTargetAttempts = 0;
    this.lateInstanceTargetInstalls = 0;
    this.lateInstanceTargetWriteRejects = 0;
    this.lateInstanceTargetNotReady = 0;
    // Exported "specok" globals of live modules with speculative monomorphic
    // links; zeroed synchronously on every class registration so mid-run
    // receivers of new classes fall to the generic path.
    this.specokGlobals = [];
  }

  onClassEpochBump() {
    for (const g of this.specokGlobals) g.value = 0;
  }

  // The world a deferrable demotion depends on: which classes exist
  // (classEpoch) and which modules are compiled (compileEpoch, bumped by every
  // successful compile). Class *initialization* is deliberately absent: it is
  // versioned (jvm.classInitializationEpoch) and adding it here was measured
  // to help nothing while making this coarse trigger fire more often, because
  // the rebuild budget is spent during the opening burst either way. Modules
  // whose demotions named a class use depsMoved's precise path instead; this
  // remains only for losses that name none.
  depWorldVersion() {
    return `${this.jvm.classEpoch || 0}:${this.compileEpoch}`;
  }

  // Readiness of the specific classes a module's demotions named: absent,
  // loaded, or initialized. Both steps matter and they happen at different
  // times — `invoke X.m unresolved` clears on the load, `new X not
  // initialized` only on the <clinit> — so a single "is it there" bit would
  // spend the rebuild budget on the first and never see the second.
  // A blocker naming a callee METHOD (it carries a descriptor, so it contains
  // '(' — a class name never does) asks a different question: not whether a
  // class arrived, but whether that method now owns a module. Class readiness
  // cannot answer it, since the owning class is usually initialized long
  // before its methods compile, which left such a module waiting on a
  // signature that could never move again. Readiness here is only a trigger:
  // if the rebuild still cannot link the callee, the bit has already flipped
  // and will not fire a second time.
  // Does `Class.field:Desc` have a cell yet? Same superclass walk the field
  // import does, so the answer is exactly the one that refused the block.
  staticFieldResolves(blocker) {
    const cut = blocker.lastIndexOf('.');
    const colon = blocker.indexOf(':', cut);
    if (cut < 0 || colon < 0) return false;
    const fieldName = blocker.slice(cut + 1, colon);
    const fieldKey = `${fieldName}${blocker.slice(colon)}`;
    let current = blocker.slice(0, cut);
    while (current) {
      const cd = this.jvm.classes[current];
      if (cd && cd.staticFields &&
          (cd.staticFields.has(fieldKey) || cd.staticFields.has(fieldName))) return true;
      current = cd && cd.ast && cd.ast.classes[0] ? cd.ast.classes[0].superClassName : null;
    }
    return false;
  }

  // `asOf` bounds which readiness counts: a compile stamps its signature as of
  // the epoch it STARTED at, so callees it made ready along the way still read
  // as blocked and the next entry sees the signature move.
  blockerSignature(blockers, asOf = Infinity) {
    if (!blockers || !blockers.length) return '';
    let sig = '';
    for (const blocker of blockers) {
      if (blocker.includes('(')) {
        const epoch = this.keyReadyEpoch.get(blocker);
        sig += (epoch !== undefined && epoch < asOf) ? '2' : '0';
        continue;
      }
      // `Class.field:Desc` — a static field CELL. Class names carry neither
      // ':' nor '(', and method keys are already taken above.
      if (blocker.includes(':')) {
        sig += this.staticFieldResolves(blocker) ? '2' : '0';
        continue;
      }
      sig += !this.jvm.classes[blocker] ? '0'
        : this.jvm.classInitializationState.get(blocker) === 'INITIALIZED' ? '2' : '1';
    }
    return sig;
  }

  // Has the world this module lost something to actually moved? When the
  // demotions named classes, that question is exactly about those classes;
  // the coarse world version is the fallback for losses that name none.
  depsMoved(st) {
    if (st.blockers && st.blockers.length) {
      return this.blockerSignature(st.blockers) !== st.blockerSig;
    }
    return st.depWorld !== this.depWorldVersion();
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
    if (frame.method.name === '<init>' || frame.method.name === '<clinit>') {
      if (this.census) this._censusNote(frame, 'ctor-or-clinit');
      return null;
    }
    const debug = this.jvm.debugManager;
    if (debug && debug.debugMode) return null;
    // JVM_JIT_DENY has to remove every compiled copy of a class's methods, or
    // a bisect over classes reports the wrong owner. This tier consulted no
    // deny list, so denying a class silently left its Wasm module compiled and
    // running and the class looked innocent.
    if (this.jit.jitDenied(frame.method)) {
      if (this.census) this._censusNote(frame, 'jit-denied');
      return null;
    }

    const st = this.methodState(frame);
    if (st.status === 'failed') {
      if (this.census) this._censusNote(frame, `failed:${st.failReason || '?'}`);
      return null;
    }

    if (st.status === 'cold') {
      st.entries += 1;
      // A deferral that named its blockers (reference-return dependency)
      // is retried only once one of them actually moved; any other epoch
      // bump cannot change its outcome. Retrying on every bump made a
      // reference-returning getter called from everywhere recompile on its
      // next call after each successful compile elsewhere (GeoBlox
      // ua.c()Lgd;: 12,527 identical failures, ~30 s of the START GAME
      // stall on Firefox).
      // A deferred module retries immediately once a named blocker moved;
      // otherwise only after a geometrically growing number of epochs (a
      // compile elsewhere may help, but not every one of them), and failing
      // that after the entry backoff. Retrying on every epoch bump made a
      // hot method that keeps failing rebuild once per module compiled
      // during a transition (GeoBlox START GAME: ua.c()Lgd; 12,527 identical
      // failures, kc.b(I)V 11 x 350 ms).
      const blockersResolved = st.deferredEpoch !== undefined &&
        st.deferredBlockerSig !== undefined && st.blockers && st.blockers.length &&
        this.blockersResolved(st.blockers, st.deferredBlockerSig);
      // A failed compile of a large method costs hundreds of ms; unless its
      // blockers are all resolved, do not spend more than ~5% of wall time
      // failing it again (retryNotBeforeMs, stamped by compile()).
      if (!blockersResolved && st.retryNotBeforeMs !== undefined &&
          nowMs() < st.retryNotBeforeMs) {
        if (this.census) this._censusNote(frame, 'retry-budget');
        return null;
      }
      const dependencyChanged = blockersResolved || (st.deferredEpoch !== undefined &&
        st.deferredEpoch !== this.compileEpoch &&
        this.compileEpoch - st.deferredEpoch >= (st.deferredEpochGap || 1));
      const threshold = dependencyChanged ? 1 : (st.retryAfter || this.warmupThreshold);
      // hasBackwardBranch is eligibility-aware and already excludes
      // opaque-control methods; see the note on it in JitCompiler.
      if (st.entries < threshold || !this.jit.hasBackwardBranch(frame.method)) {
        if (this.census) {
          this._censusNote(frame,
            st.entries < threshold ? 'below-warmup' : 'no-supported-backedge');
        }
        return null;
      }
      this.compile(frame, st);
      if (st.status !== 'ready') {
        if (this.census) {
          this._censusNote(frame, st.status === 'failed'
            ? `failed:${st.failReason || '?'}` : 'deferred');
        }
        return null;
      }
    }
    if (st.status !== 'ready') {
      if (this.census) this._censusNote(frame, `not-ready:${st.status}`);
      return null;
    }

    // A module built while a dependency was merely pending keeps the loss for
    // good: blocks stay exit stubs, and — more expensively — call sites that
    // could have been inlined or direct-linked stay bound to the generic
    // dispatch import (measured on runPoly: ~116 ns/call against ~1 ns when
    // the same site inlines). The exit-count trigger in exitTo cannot rescue
    // either: it needs 20000 exits, but a method whose loop body is an exit
    // stub stops being entered long before that (measured: 13 wasm
    // transitions across 20000 iterations), and a site on the dispatch import
    // never exits at all. So rebuild here instead, and only when the world
    // that produced those demotions has actually changed — not on a timer or
    // an exit rate, both of which measured negative.
    if (st.partialDeps && (st.partialDepsStructured || st.partialDepsUnserviceable) &&
        this.depsMoved(st)) {
      st.depWorld = this.depWorldVersion();
      st.blockerSig = this.blockerSignature(st.blockers);
      if ((st.depRecompiles || 0) < this.depRecompileLimit) {
        st.depRecompiles = (st.depRecompiles || 0) + 1;
        st.status = 'cold';
        st.entries = 0;
        st.retryAfter = 1;
        st.meta = null;
        st.run = null;
        st.osr = null;
        st.callee = null;
        if (this.census) this._censusNote(frame, 'dependency-world-grew');
        return null;
      }
    }

    // Speculative modules (CHA-based inlined instance calls — instanceof
    // guards, guard-elided `this` sites, or speculative monomorphic direct
    // links) bake the compile-time world. They are excluded from every
    // static linking path, so this pre-entry check is the gate: when the
    // class world grew, re-run the plan-time site checks; the module
    // survives when every speculated cone is unchanged (the common case —
    // most loads are unrelated), re-arming its in-wasm specok flag, and is
    // dropped for a recompile only when one actually grew.
    for (const m of [st.meta, st.osr && st.osr.meta]) {
      if (!(m && m.specSites && m.specSites.length &&
          m.specEpoch !== (this.jvm.classEpoch || 0))) continue;
      if (revalidateSpeculations(this.jvm, this.hierarchy, m.specSites)) {
        m.specEpoch = this.jvm.classEpoch || 0;
        if (m.specok) m.specok.value = 1;
      } else {
        st.status = 'cold';
        st.entries = 0;
        st.retryAfter = 1;
        st.meta = null;
        st.run = null;
        st.osr = null;
        st.callee = null;
        if (this.census) this._censusNote(frame, 'speculation-invalidated');
        return null;
      }
    }

    // External calls and interpreter resumptions have no wasm carry locals.
    // Enter only where the verifier shape is empty and the materialized JVM
    // operand stack agrees; non-empty shapes are reachable solely through a
    // compiled predecessor inside the same wasm run.
    if (!frame.stack.isEmpty()) {
      if (this.census) this._censusNote(frame, 'nonempty-operand-stack');
      return null;
    }
    const blk = st.meta.blockOfItem.get(frame.pc);
    if (blk !== undefined && st.meta.externalEntry.has(blk)) {
      if (this.census) this._censusNote(frame, 'entered');
      return { st, blk };
    }
    // structured primary only admits pc 0; mid-method (loop OSR, fuel-exit
    // resume) entries go through the dispatcher module kept alongside it
    if (st.osr) {
      const oblk = st.osr.meta.blockOfItem.get(frame.pc);
      if (oblk !== undefined && st.osr.meta.externalEntry.has(oblk)) {
        if (this.census) this._censusNote(frame, 'entered-osr');
        return { st, blk: oblk, osr: true };
      }
    }
    if (this.census) this._censusNote(frame, 'no-external-entry-at-pc');
    return null;
  }

  // JVM_WASM_CENSUS=1 only: tally, per method, every outcome the wasm gate
  // reached. Answers "why is this hot method not on the wasm tier" without
  // reading a debug log — the state map is a WeakMap and cannot be walked.
  _censusNote(frame, reason) {
    if (!this.census) return;
    const className = frame.className || frame.method.className || '?';
    const key = `${className}.${frame.method.name}${frame.method.descriptor}`;
    let row = this.census.get(key);
    if (!row) {
      row = { reasons: new Map(), st: null };
      this.census.set(key, row);
    }
    if (!row.st) row.st = this.state.get(frame.method) || null;
    row.reasons.set(reason, (row.reasons.get(reason) || 0) + 1);
  }

  dumpCensus() {
    if (!this.census || !this.census.size) return;
    const rows = [...this.census].map(([key, row]) => {
      let attempts = 0;
      for (const count of row.reasons.values()) attempts += count;
      const st = row.st || {};
      // Whether the module COVERS the whole method, which is a different
      // question from whether the gate let it in. A tier-preference rule can
      // only safely take a method off the JS tier when wasm runs it end to
      // end; admitting a partial module that exits on every entry is the
      // kta.a([II)V failure mode (runs==exits) the JS preference exists to
      // avoid. Recorded so that distinction can be measured, not guessed.
      const meta = st.meta || (st.callee && st.callee.meta) || null;
      return {
        method: key,
        attempts,
        status: st.status || '?',
        full: meta ? !!meta.fullyCompiled : undefined,
        normalFull: meta ? !!meta.normalFlowFullyCompiled : undefined,
        runs: st.runs || 0,
        exits: st.exits || 0,
        fuelExits: st.fuelExits || 0,
        uncovered: st.uncovered ? Object.fromEntries(st.uncovered) : undefined,
        reasons: Object.fromEntries([...row.reasons]
          .sort((left, right) => right[1] - left[1])),
      };
    }).sort((left, right) => right.attempts - left.attempts);
    // Attempt counts do NOT rank by time — a method entered once around a
    // multi-second loop lands at the bottom — so the whole census must
    // survive. Console output is truncated by the launcher's rolling child
    // log; a file write is not.
    const target = this.censusPath;
    if (target) {
      try {
        const fs = require('fs');
        const path = require('path');
        const file = target.replace(/%p/g, String(process.pid));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ methods: rows }));
        console.error(`[wasm-census] wrote ${rows.length} methods to ${file}`);
        return;
      } catch (err) {
        console.error(`[wasm-census] file write failed: ${err.message}`);
      }
    }
    console.error(`[wasm-census] ${rows.length} methods reached the wasm gate`);
    for (const row of rows) {
      const reasons = Object.entries(row.reasons)
        .map(([reason, count]) => `${reason}=${count}`).join(' ');
      console.error(`[wasm-census] ${row.method} attempts=${row.attempts} ` +
        `status=${row.status} runs=${row.runs} exits=${row.exits} ` +
        `fuelExits=${row.fuelExits} :: ${reasons}`);
    }
  }

  // Shadow accounting only: record what the gate would decide, run nothing.
  censusProbe(frame) {
    if (!this.censusShadow) return;
    try {
      this.prepare(frame);
    } catch (err) {
      if (this.debug) console.error(`[wasm-census] probe threw: ${err.message}`);
    }
  }

  // Does wasm cover this method END TO END? The JS tier is consulted first,
  // so a method it can compile never reaches the gate at all; in the regression
  // that is over half of guest-compiled time, and it is why relaxing gate
  // rules (the reference-return test) measured flat: the relaxed rule sits
  // downstream of a gate nothing asks. Order matters, so ask once here.
  //
  // The answer must be "covers the whole body", not "the gate would let it
  // in". A partial module that leaves on every entry is the kta.a([II)V shape
  // (runs==exits) the whole-method-JS preference exists to avoid, so
  // fullyCompiled — no demoted block, no deopt site, no exception table — is
  // the condition, plus a compiled pc-0 entry to enter through.
  probeFullCoverage(frame) {
    if (!this.preferFullCoverage || !this.enabled) return false;
    const method = frame.method;
    const known = this.fullCoverage.get(method);
    if (known !== undefined) return known;
    if (this.preferFullCoverageOnly) {
      const className = frame.className || method.className || '?';
      if (!this.preferFullCoverageOnly.has(
        `${className}.${method.name}${method.descriptor}`)) return false;
    }
    this.fullCoverageProbes += 1;
    try {
      this.prepare(frame);
    } catch (err) {
      if (this.debug) console.error(`[wasm-coverage] probe threw: ${err.message}`);
    }
    const st = this.state.get(method);
    if (!st) return false;
    // Warmup and deferral are not verdicts — probing again later is exactly
    // how the method gets its chance — so do not cache them as a refusal.
    if (st.status === 'cold' || st.status === 'deferred') return false;
    const meta = st.status === 'ready' ? st.meta : null;
    // Debug bisection only: accept a PARTIAL module too, so that forcibly
    // demoting blocks (JVM_WASM_DEMOTE_BLOCKS) does not simply hand the method
    // back to the JS tier and hide the very miscompile being localised.
    // Partial modules exit and resume interpreted, which is sound, just slow.
    const full = process.env.JVM_WASM_PREFER_FORCE === '1'
      ? !!(meta && meta.externalEntry.has(0))
      : !!(meta && meta.fullyCompiled && meta.externalEntry.has(0));
    this.fullCoverage.set(method, full);
    if (full) this.fullCoverageWins += 1;
    return full;
  }

  tryRunFrame(frame, thread) {
    const prep = this.prepare(frame);
    if (!prep) return { handled: false };
    return this.execute(frame, thread, prep.st, prep.blk, false, prep.osr === true);
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
    const result = this.execute(frame, thread, prep.st, prep.blk, true, prep.osr === true);
    if (result.returned) {
      const meta = prep.osr === true ? prep.st.osr.meta : prep.st.meta;
      return { returned: true, isVoid: meta.retChar === 'V', value: meta.box.ret };
    }
    // deopted: nested callee frames were materialized ABOVE this child — the
    // caller must yield to the scheduler rather than resume the child itself
    return { exited: true, deopted: result.deopted === true };
  }

  compile(frame, st, options = {}) {
    // Diagnostic: accumulate wall time per module compile (JVM_JIT_COMPILE_STATS
    // census reads `compileStats`). Cheap enough to stay on.
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    const parentNested = this._compileNestedMs || 0;
    this._compileNestedMs = 0;
    const statusBefore = st && st.status;
    try {
      return this._compileUntimed(frame, st, options);
    } finally {
      const ms = now() - t0;
      const nested = this._compileNestedMs || 0;
      this._compileNestedMs = parentNested + ms;
      if (st) {
        const selfMs = Math.max(0, ms - nested);
        st.retryNotBeforeMs = (st.status === 'ready' ||
            selfMs < this.failedCompileRetryMinMs) ? undefined
          : now() + selfMs * this.failedCompileRetryFactor;
      }
      if (!this.compileStats) this.compileStats = new Map();
      const key = st && st.key ? st.key : String(frame && frame.method && frame.method.name);
      const e = this.compileStats.get(key) || { ms: 0, selfMs: 0, count: 0, callee: 0, st: null, method: null, outcomes: {} };
      e.ms += ms; e.selfMs += ms - nested; e.count += 1; if (options.asCallee === true) e.callee += 1;
      const tEnd = now(); if (e.firstAt === undefined) e.firstAt = t0; e.lastAt = tEnd;
      if (!e.windowMs) e.windowMs = []; e.windowMs.push([Math.round(t0), Math.round(ms - nested)]);
      e.st = st; e.method = frame && frame.method;
      const outcome = `${statusBefore}->${st && st.status}:${(st && st.status !== 'ready' && st.lastCompileError) || ''}`;
      e.outcomes[outcome] = (e.outcomes[outcome] || 0) + 1;
      this.compileStats.set(key, e);
    }
  }

  _compileUntimed(frame, st, options = {}) {
    // Callee compiles reach this without going through prepare(), so a denied
    // class would still be inlined into another method's module.
    if (this.jit.jitDenied(frame.method)) {
      st.status = 'failed';
      st.failReason = 'jit-denied';
      return;
    }
    const asCallee = options.asCallee === true;
    const isRecompile = st.status === 'ready';
    const className = frame.className || (frame.method.className) || '?';
    st.key = `${className}.${frame.method.name}${frame.method.descriptor}`;
    // The world this compile is about to read. Callee compiles it triggers
    // will advance the epoch, so the blocker signature is stamped against
    // this value rather than the one at the end. See blockerSignature.
    const startEpoch = this.compileEpoch;
    // Prevent recursive static call graphs from trying to compile the same
    // method again while its translator is still discovering callees.
    st.status = 'compiling';
    let validatingBytes = null; // last bytes handed to WebAssembly.Module, for reject dumps
    let primaryMeta = null; // census-only: the meta a partial-module reject saw
    try {
      let structuredMeta = null;
      let structuredDeferred = false;
      let structuredBlockers = [];
      if (this.structuredEnabled) {
        try {
          const StructuredWasmCompiler = require('./StructuredWasmCompiler');
          structuredMeta = new StructuredWasmCompiler(this.jvm, frame.method, className, this).translate();
          this.structuredCompiles += 1;
        } catch (err) {
          if (!(err instanceof Unsupported)) throw err;
          st.structuredFailReason = err.message;
          // A structured rejection for a reason a later class load can undo is
          // the strongest rebuild signal there is: the whole inlining backend
          // was lost, not one block. Recorded here because the dispatcher meta
          // built below cannot say why the better tier declined.
          structuredDeferred = DEFERRABLE_DEMOTE.test(err.message);
          if (structuredDeferred) structuredBlockers = blockedNames(err);
          if (this.debug) console.error(`[wasmjit] structured fallback ${st.key}: ${err.message}`);
        }
      }
      // The dispatcher module is built even when the structured one succeeds:
      // structured control flow admits entry at pc 0 only, but hot loops are
      // first observed mid-method and fuel exits resume mid-loop — both need
      // dispatcher OSR entry or the hottest kernels never run compiled.
      let meta = null;
      try {
        const translator = new MethodTranslator(this.jvm, frame.method, className, this);
        meta = translator.translate();
      } catch (err) {
        if (!(err instanceof Unsupported) || !structuredMeta) throw err;
      }
      // A structured module with BIGGER normal-flow coverage gaps than the
      // dispatcher's (e.g. it must demote a call the dispatcher links
      // partially) would give that coverage away on every pc-0 entry, then
      // exit into a tier that keeps the frame. Gap counts, not covered
      // counts: the tiers partition and expand items differently. A
      // gap-free structured module always wins — it is the faster tier.
      // ... unless discarding would lose callee-linkability: links require a
      // compiled pc-0 entry and unboxed slots — a dispatcher module missing
      // either can never be linked no matter how much more it covers.
      const linkable = (m) => m.externalEntry.has(0) && !m.boxedCount;
      const coverageDiagnostic = (candidate) => candidate ? {
        normalFlowFullyCompiled: Boolean(candidate.normalFlowFullyCompiled),
        fullyCompiled: Boolean(candidate.fullyCompiled),
        uncoveredItems: Number(candidate.uncoveredItems) || 0,
        boxedCount: Number(candidate.boxedCount) || 0,
        entryCompiled: candidate.externalEntry.has(0),
        demoteReasons: [...(candidate.demoteReasons || new Map()).entries()],
      } : null;
      st.wasmCandidateCoverage = {
        structured: coverageDiagnostic(structuredMeta),
        dispatcher: coverageDiagnostic(meta),
        structuredDiscarded: false,
      };
      if (structuredMeta && meta &&
          structuredMeta.uncoveredItems > meta.uncoveredItems &&
          (linkable(meta) || !linkable(structuredMeta))) {
        st.wasmCandidateCoverage.structuredDiscarded = true;
        structuredMeta = null;
      }
      // A partial module can leave and later resume with locals captured
      // before its first compiled block. Until boolean-static values have a
      // verifier-backed spill proof across every unsupported edge, keep that
      // shape out of wasm: treating a lost opaque-predicate local as true can
      // skip arbitrary guest side effects. BOTH modules are checked, not just
      // the primary one — the dispatcher module stays reachable through OSR
      // entry even when the structured module is complete, so a partial
      // dispatcher carries the same hazard.
      if (capturesBooleanStatic(frame.method) &&
          ((meta && !meta.fullyCompiled) ||
            (structuredMeta && !structuredMeta.fullyCompiled))) {
        throw new Unsupported('partial module captures a boolean static');
      }
      const primary = structuredMeta || meta;
      primaryMeta = primary;
      // A partial module may stop after consuming a reference-producing call
      // or immediately before object construction, then resume through the
      // canonical scheduler. Until every such edge carries a verifier-backed
      // reference return slot, do not let it publish a successful non-void
      // completion to an already-resumed caller. Primitive and void kernels
      // retain partial Wasm, as do reference-returning methods whose complete
      // normal flow stays inside one module.
      //
      // That last clause is what normalFlowFullyCompiled means, and it is the
      // condition the hazard actually needs: a mid-method stop can only occur
      // at a demoted block or a deopt site, and there are none. fullyCompiled
      // is strictly stronger — the structured tier also clears it for any
      // non-empty EXCEPTION TABLE, and the dispatcher tier for any demoted
      // block whether or not normal flow can reach it. Neither adds a way for
      // this module to publish a return value after a partial exit: an
      // exception leaves through the EH protocol with the interpreter, not
      // the ret box. Testing fullyCompiled here rejected reference-returning
      // methods that merely contain a try/catch, and those rejects cascade —
      // an unlinkable callee makes its caller partial, and a caller that also
      // returns a reference is then rejected by this same rule. On Tomb
      // Racer that chain accounted for 21% of guest-compiled loading time,
      // rooted in leaves whose only disqualification was an exception table.
      //
      // OFF BY DEFAULT (JVM_WASM_RELAXED_REF_RETURN=1 enables it). The
      // argument above is a reading of the code, not a measurement: the one
      // A/B run so far landed on a machine whose baseline had drifted 2x, so
      // it showed nothing either way. Admitting more partial modules can also
      // backfire on its own terms — kta.a([II)V already runs at
      // runs==exits, and partial wasm that exits on every entry is exactly
      // what the whole-method-JS preference exists to avoid.
      const refReturnComplete = this.relaxedRefReturn
        ? primary.normalFlowFullyCompiled : primary.fullyCompiled;
      if (!refReturnComplete &&
          (primary.retChar === 'L' || primary.retChar === '[')) {
        st.referenceReturnRejection = {
          relaxed: this.relaxedRefReturn,
          normalFlowFullyCompiled: Boolean(primary.normalFlowFullyCompiled),
          fullyCompiled: Boolean(primary.fullyCompiled),
          uncoveredItems: Number(primary.uncoveredItems) || 0,
          demoteReasons: [...(primary.demoteReasons || new Map()).entries()],
          structured: primary === structuredMeta,
        };
        const reasons = [...(primary.demoteReasons || new Map()).values()];
        const blockers = [...(primary.demoteBlockers || [])];
        const dependencyOnly = reasons.length > 0 && blockers.length > 0 &&
          reasons.every((reason) => DEFERRABLE_DEMOTE.test(reason));
        throw new Unsupported('partial module has a reference return'
          + (this.debug
            ? ` [normalFlow=${primary.normalFlowFullyCompiled} full=${primary.fullyCompiled}`
              + ` demotes=${JSON.stringify([...(primary.demoteReasons || [])])}]` : ''),
        dependencyOnly ? blockers : null);
      }
      if (asCallee) {
        // A linked callee spills into a real scratch frame and unwinds via
        // NestedDeopt when it reaches a demoted block, so demoted diagnostic
        // blocks in normal flow are acceptable — but the entry block must be
        // compiled and slots unboxed (boxed slots would read the junk/scratch
        // frame mid-run). It need not contain a loop: removing the call
        // boundary is precisely what lets the caller's loop remain compiled.
        if (!primary.externalEntry.has(0) || primary.boxedCount) {
          throw new Unsupported('callee entry is not compiled');
        }
      } else {
        // Standalone entry has call/materialization overhead, so require at
        // least one fully compiled loop — in EITHER module: inlining can make
        // the structured module cover a loop whose call the dispatcher could
        // only demote (uncompilable callee), and vice versa.
        const hasCompiledLoop = (meta && this.hasSupportedBackwardBranch(frame.method, meta)) ||
          (structuredMeta && this.hasSupportedBackwardBranch(frame.method, structuredMeta));
        if (!hasCompiledLoop) {
          if (this.debug && meta && meta.demoteReasons.size) {
            const details = [...meta.demoteReasons.entries()]
              .map(([block, reason]) => `${block}:${reason}`).join(', ');
            console.error(`[wasmjit] no compiled loop ${st.key}: ${details}`);
          }
          // Name what has to change before a retry could compile a loop:
          // when every demotion in both modules is a deferrable dependency,
          // the entry gate waits for exactly those blockers instead of
          // retrying after every unrelated compile (kc.b(I)V: 11 identical
          // 350 ms failures inside one GeoBlox START GAME).
          const loopReasons = [];
          const loopBlockers = new Set();
          for (const m of [meta, structuredMeta]) {
            if (!m) continue;
            loopReasons.push(...(m.demoteReasons || new Map()).values());
            for (const b of (m.demoteBlockers || [])) loopBlockers.add(b);
          }
          const loopDependencyOnly = loopReasons.length > 0 && loopBlockers.size > 0 &&
            loopReasons.every((reason) => DEFERRABLE_DEMOTE.test(reason));
          throw new Unsupported('no compiled loop',
            loopDependencyOnly ? [...loopBlockers] : null);
        }
      }
      validatingBytes = primary.bytes;
      const module = new WebAssembly.Module(primary.bytes);
      const instance = new WebAssembly.Instance(module, primary.importObject);
      st.meta = primary;
      st.run = instance.exports.run;
      primary.retv = instance.exports.retv || null;
      primary.runv = instance.exports.runv || null;
      primary.specok = instance.exports.specok || null;
      if (primary.specok) this.specokGlobals.push(primary.specok);
      if (structuredMeta && meta) {
        validatingBytes = meta.bytes;
        const osrModule = new WebAssembly.Module(meta.bytes);
        const osrInstance = new WebAssembly.Instance(osrModule, meta.importObject);
        meta.retv = osrInstance.exports.retv || null;
        meta.runv = osrInstance.exports.runv || null;
        meta.specok = osrInstance.exports.specok || null;
        if (meta.specok) this.specokGlobals.push(meta.specok);
        // JVM_WASM_NO_OSR=1: keep the structured module but refuse the
        // dispatcher OSR companion, so a fuel exit resumes ONLY in the
        // interpreter. Separates "the spill wrote the wrong locals" from
        // "the OSR module re-entered mid-method on those locals".
        // JVM_WASM_NO_OSR_METHODS=<substr,...> does the same for named methods
        // only, so the offending module can be bisected out of a whole boot.
        const osrBanned = process.env.JVM_WASM_NO_OSR === '1'
          || (this.noOsrMethods && this.noOsrMethods.some((s) => st.key.includes(s)));
        st.osr = osrBanned ? null : { meta, run: osrInstance.exports.run };
      } else {
        st.osr = null;
      }
      // Callee links want the most-complete module, which is not always the
      // primary: a structured module with demoted blocks deopts per call
      // where a fully-compiled dispatcher module would run through.
      const rank = (m) => (m.fullyCompiled ? 2 : m.normalFlowFullyCompiled ? 1 : 0);
      st.callee = st.osr && rank(st.osr.meta) > rank(st.meta) ? st.osr : null;
      st.status = 'ready';
      this.jit.publishWasmTargetReady?.(frame.method);
      // Stamped before this compile's own epoch bump, so "ready at epoch E"
      // always compares strictly less than any later compile's start epoch.
      if (st.key && !this.keyReadyEpoch.has(st.key)) {
        this.keyReadyEpoch.set(st.key, this.compileEpoch);
      }
      st.retryAfter = undefined;
      st.deferredEpoch = undefined;
      st.calleeDeferredEpoch = undefined;
      st.deferredBlockerSig = undefined;
      st.deferredEpochGap = undefined;
      st.calleeBlockers = null;
      st.calleeBlockerSig = undefined;
      st.calleeRetryEpoch = undefined;
      st.calleeRetryAfter = undefined;
      // Remember whether this module lost anything for a reason that a later
      // class load can undo — a demoted block, or the structured tier itself
      // declining. The entry gate rebuilds such a module once the world that
      // produced the loss changes. See DEFERRABLE_DEMOTE.
      st.partialDeps = structuredDeferred ||
        [...primary.demoteReasons.values()]
          .some((reason) => DEFERRABLE_DEMOTE.test(reason));
      // Which loss it was. A structured module that merely demoted a block is
      // left alone: on the dispatcher tier the same rebuild would discard
      // modules that late instance-target installation already serves without
      // exiting, which is strictly better. See the late-target tests in
      // wasmInstanceLink.
      st.partialDepsStructured = structuredDeferred || !!(st.meta && st.meta.structured);
      // ...but a loss nothing can repair at runtime reopens the gate whatever
      // tier produced the module. See UNSERVICEABLE_DEMOTE.
      st.partialDepsUnserviceable = [...primary.demoteReasons.values()]
        .some((reason) => UNSERVICEABLE_DEMOTE.test(reason));
      // Which classes have to change state before rebuilding could possibly
      // help. When this is known the rebuild waits for exactly them, which is
      // both more likely to succeed and far less likely to storm than waiting
      // for any world movement at all.
      const blockers = new Set(primary.demoteBlockers || []);
      for (const name of structuredBlockers) blockers.add(name);
      st.blockers = [...blockers].sort();
      this.compileEpoch += 1;
      // Stamped after the bump this compile itself contributes, so a module
      // never triggers its own rebuild.
      st.depWorld = this.depWorldVersion();
      st.blockerSig = this.blockerSignature(st.blockers, startEpoch);
      if (!st.listed) { st.listed = true; this.compiled.push(st); }
      // JVM_WASM_DUMP_ACCEPT=<dir> writes each accepted module so its wat can
      // be diffed against hand-written wasm for the same Java method. The
      // reject dump next to it only ever sees modules that failed to validate.
      if (process.env.JVM_WASM_DUMP_ACCEPT && primary.bytes) {
        const safe = st.key.replace(/[^\w.]/g, '_');
        const dir = process.env.JVM_WASM_DUMP_ACCEPT;
        try {
          require('fs').mkdirSync(dir, { recursive: true });
          require('fs').writeFileSync(`${dir}/${safe}.wasm`,
            Buffer.from(primary.bytes));
        } catch { /* dump only */ }
      }
      if (this.debug) {
        console.error(`[wasmjit] ${isRecompile ? 'recompiled' : 'compiled'} ${st.key}: ${primary.bytes.length}B, ` +
          `${primary.supportedBlocks.size}/${primary.blockCount} blocks, ${primary.fieldCacheCount} field caches` +
          (primary.arrayCacheCount ? ` ${primary.arrayCacheCount} array caches` : '') +
          (structuredMeta ? ` structured${st.osr ? '+osr' : ''}` : '') +
          (primary.inlinedCalls ? ` +${primary.inlinedCalls} inlined` : '') +
          (primary.demoteReasons.size ? ` (exits: ${[...primary.demoteReasons.values()].join('; ')})` : ''));
      }
    } catch (err) {
      if (process.env.JVM_WASM_DUMP_REJECT && validatingBytes &&
          /WebAssembly/.test(err.message)) {
        const file = `${process.env.JVM_WASM_DUMP_REJECT}/${st.key.replace(/[^\w.]/g, '_')}.wasm`;
        try { require('fs').writeFileSync(file, Buffer.from(validatingBytes)); } catch { /* dump only */ }
        if (this.debug) console.error(`[wasmjit] dumped rejected module to ${file}`);
      }
      st.lastCompileError = err && err.message ? String(err.message).slice(0, 80) : String(err);
      if (isRecompile) {
        // keep the previous working module
        st.status = 'ready';
        if (this.debug) console.error(`[wasmjit] recompile of ${st.key} failed (${err.message}), keeping old module`);
        return;
      }
      if (asCallee && err instanceof Unsupported) {
        // Callee linking is stricter than standalone execution. A failed link
        // must not blacklist the method from later standalone compilation.
        // Reconsider it as a callee only once something that could change the
        // outcome has changed: the named blockers (a reference-returning
        // callee waits for exactly the methods its demoted blocks depend on),
        // or — when nothing is named — after an exponentially growing number
        // of epochs. Re-arming on every epoch bump made a callee referenced
        // from many sites recompile once per site per successful compile
        // anywhere (measured: ua.c()Lgd; 12,527 identical failures, 30 s of
        // the GeoBlox START GAME stall on Firefox).
        st.calleeDeferredEpoch = this.compileEpoch;
        const calleeBlockers = blockedNames(err);
        if (calleeBlockers.length) {
          st.calleeBlockers = [...calleeBlockers].sort();
          st.calleeBlockerSig = this.blockerSignature(st.calleeBlockers);
        } else {
          st.calleeBlockers = null;
          st.calleeBlockerSig = undefined;
        }
        st.calleeRetryAfter = Math.min(this.retryBackoffMax,
          (st.calleeRetryAfter || 1) * 2);
        st.calleeRetryEpoch = this.compileEpoch + st.calleeRetryAfter;
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
        const loopBlockers = blockedNames(err);
        if (loopBlockers.length) {
          st.blockers = [...loopBlockers].sort();
          st.deferredBlockerSig = this.blockerSignature(st.blockers);
        } else {
          st.blockers = null;
          st.deferredBlockerSig = undefined;
        }
        st.deferredEpochGap = Math.min(this.retryBackoffMax,
          (st.deferredEpochGap || 2) * 2);
        st.status = 'cold';
        st.entries = 0;
        if (this.debug) console.error(`[wasmjit] deferred ${st.key}: no compiled loop yet ` +
          `(retry after ${st.retryAfter} entries or dependency compilation)`);
        return;
      }
      if (err instanceof Unsupported &&
          err.message.startsWith('partial module has a reference return') &&
          blockedNames(err).length) {
        st.retryAfter = Math.min(this.retryBackoffMax,
          (st.retryAfter || Math.max(1, this.warmupThreshold)) * 2);
        st.deferredEpoch = this.compileEpoch;
        st.deferredEpochGap = Math.min(this.retryBackoffMax,
          (st.deferredEpochGap || 2) * 2);
        st.blockers = blockedNames(err).sort();
        st.deferredBlockerSig = this.blockerSignature(st.blockers);
        st.status = 'cold';
        st.entries = 0;
        if (this.debug) console.error(
          `[wasmjit] deferred ${st.key}: reference-return dependency`);
        return;
      }
      st.status = 'failed';
      st.failReason = err.message;
      // A partial-module reject names the restriction but not the coverage
      // gap behind it. The demote reason is the actionable half — the opcode
      // histogram showed these gaps are made of plain iload/getfield, so the
      // blocks are excluded structurally, not for an unsupported instruction.
      if (this.census && primaryMeta) {
        const tally = new Map();
        for (const reason of (primaryMeta.demoteReasons || new Map()).values()) {
          tally.set(reason, (tally.get(reason) || 0) + 1);
        }
        for (const [op, count] of primaryMeta.uncoveredOpcodes || []) {
          tally.set(`op:${op}`, count);
        }
        if (tally.size) {
          st.uncovered = [...tally]
            .sort((left, right) => right[1] - left[1]).slice(0, 8);
        }
      }
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

  execute(frame, thread, st, blk, nested = false, osr = false) {
    const mod = osr && st.osr ? st.osr : st;
    const meta = mod.meta;
    // Diagnostic: a structured fuel/deopt exit writes back only the slots its
    // block's SSA state defines; the dispatcher OSR module's paramSlots is
    // EVERY typed slot, so it reads slots that exit never wrote. Log the
    // difference at each OSR entry.
    if (this.traceResumePattern && osr && !st.osrLogged) {
      st.osrLogged = true; // one line per method that ever re-enters via OSR
      console.error('[wasm-osr-method] ' + st.key);
    }
    if (this.traceResumePattern && osr && st.lastExitSpill) {
      const spilled = st.lastExitSpill;
      const unwritten = meta.paramSlots
        .filter((p) => !spilled.slots.includes(p.slot))
        .map((p) => ({ slot: p.slot, t: p.t, v: frame.locals[p.slot] }));
      // A slot the OSR module loads that the structured exit never wrote AND
      // that holds no value at all is read as 0/null: state invented from
      // nothing. That is the shape of the miscompile, so log only those.
      const stale = unwritten.filter((u) => u.v === undefined);
      // Only the IMMEDIATE handoff is evidence: if the interpreter advanced
      // past the exit pc before this OSR entry, it has since written every
      // slot it actually needed and an unwritten slot is simply dead.
      const hazard = stale.length > 0 && frame.pc === spilled.pc;
      if (this.traceResumePattern === '*'
        ? hazard
        : (st.key && st.key.includes(this.traceResumePattern))) {
        console.error('[wasm-resume] ' + JSON.stringify({
          method: st.key, blk, pc: frame.pc,
          lastExitPc: spilled.pc, lastExitSpilled: spilled.slots,
          // Slots the exit DROPPED (had a reaching def, filtered out) are a
          // real loss; slots merely absent from slotDefsIn had no value.
          droppedByExit: spilled.dropped,
          staleSlotsOsrReads: stale.map((u) => `${u.slot}:${u.t}`),
        }));
      }
    }
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
    this.runCount += 1;
    let status;
    try {
      status = mod.run(...args);
    } catch (err) {
      if (err instanceof NestedDeopt) {
        // A linked partial callee hit a demoted block. The import closures
        // already spilled every frame's state and set this frame's pc to the
        // post-invoke resume point; materialize the nested chain (frames are
        // innermost-first) and let the scheduler run it interpreted.
        st.exits += 1;
        for (let i = err.frames.length - 1; i >= 0; i--) {
          thread.callStack.push(err.frames[i]);
        }
        if (st.exits % 20000 === 0 && (st.recompiles || 0) < 3) {
          // pick up callee vetoes after a deopt storm
          st.recompiles = (st.recompiles || 0) + 1;
          this.compile(frame, st);
        }
        return { handled: true, deopted: true };
      }
      throw err;
    }

    if (this.traceMethodPattern && st.key &&
        st.key.includes(this.traceMethodPattern) &&
        (!this.traceExitsOnly || status !== -1)) {
      const top = thread.callStack.isEmpty() ? null : thread.callStack.peek();
      console.error('[wasmjit-transition] ' + JSON.stringify({
        method: st.key,
        nested,
        osr,
        entryBlock: blk,
        status,
        framePc: frame.pc,
        stackDepth: frame.stack.items.length,
        returnedValueType: meta.box.ret === undefined ? 'undefined'
          : meta.box.ret === null ? 'null'
            : meta.box.ret && (meta.box.ret.type || meta.box.ret._className) ||
              typeof meta.box.ret,
        top: top && `${top.className || '?'}.${
          top.method?.name || '?'}${top.method?.descriptor || ''}`,
      }));
    }

    if (status === -3) {
      // EH catch site: a guest exception was thrown at a precise pc inside a
      // live handler range. The spill import already wrote the locals
      // reaching the throw and frame.pc; dispatch through the interpreter's
      // handler search (same-frame handler, or pop-and-propagate).
      st.exits += 1;
      const exn = meta.box.pendingException;
      meta.box.pendingException = null;
      this.jvm.handleException(exn, meta.box.throwPc, thread);
      return { handled: true };
    }
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
    if (this.traceResumePattern && !osr && meta.spillSlots) {
      const rec = meta.spillSlots.get(status);
      st.lastExitSpill = {
        pc: status,
        slots: rec ? rec.slots : [],
        dropped: rec ? rec.dropped : [],
      };
    }
    frame.pc = status;
    // A structured call-site deopt exits with the nested callee's frames
    // parked on the box (innermost first): materialize them above this frame
    // so the interpreter finishes the callee before resuming here.
    const pending = meta.box.pendingFrames;
    if (pending) {
      meta.box.pendingFrames = null;
      for (let i = pending.length - 1; i >= 0; i--) thread.callStack.push(pending[i]);
    }
    // Exit storms usually mean a loop keeps leaving wasm for an invoke whose
    // callee wasn't compiled yet — recompile to bind callees that are now
    // ready. Do NOT trigger earlier or on exit rate: eager schedules measured
    // -1.4 to -2.4 fps — recompiles replace working modules with ones that
    // bind more partial callees (per-call scratch-frame overhead) and perturb
    // compile ordering for later methods.
    if (st.exits % 20000 === 0 && (st.recompiles || 0) < 3 && meta.demoteReasons.size) {
      st.recompiles = (st.recompiles || 0) + 1;
      this.compile(frame, st);
    }
    return { handled: true };
  }

  // Transitive set of field kill-keys (`name:descriptor`) a static method may
  // write, or null when unknowable (unresolved class, virtual dispatch,
  // invokedynamic). Call sites use it to kill only the matching field caches:
  // the deobfuscated-helper shape writes no fields at all, and calling it
  // should not blow away the caller's cached reads. Bytecode is immutable, so
  // a known summary is final; unknown (null) summaries are retried once per
  // compile epoch because the callee's class may load later.
  staticWriteSummary(className, name, descriptor, inProgress) {
    const key = `${className}.${name}${descriptor}`;
    const memo = this.writeSummaries.get(key);
    if (memo && (memo.keys !== null || memo.epoch === this.compileEpoch)) return memo.keys;
    if (inProgress) {
      // A direct-static recursion edge adds no effects beyond the method body
      // already being scanned. Treat the backedge as an empty delta; the
      // outer walk still accumulates every direct write and every non-cyclic
      // callee in the strongly connected component. Returning "unknown" here
      // unnecessarily invalidates otherwise exact caller field summaries.
      if (inProgress.has(key)) return EMPTY_WRITE_SET;
    } else {
      inProgress = new Set();
    }
    inProgress.add(key);
    const keys = this.computeWriteSummary(className, name, descriptor, inProgress);
    inProgress.delete(key);
    this.writeSummaries.set(key, { keys, epoch: this.compileEpoch });
    return keys;
  }

  // Write summary for a resolved instance-method implementation. Sound
  // without epoch invalidation: the call site's dispatch map is baked, so
  // only these exact impls can complete without a deopt (a receiver of a
  // later-loaded class misses the map and exits the module, after which
  // every cache reloads); each summary reads only the impl's immutable
  // bytecode and goes pessimistic (null) on any nested instance dispatch.
  instanceWriteSummary(className, name, descriptor) {
    const key = `${className}.${name}${descriptor}#inst`;
    const memo = this.writeSummaries.get(key);
    if (memo && (memo.keys !== null || memo.epoch === this.compileEpoch)) return memo.keys;
    const keys = this.computeWriteSummary(className, name, descriptor, new Set(), true);
    this.writeSummaries.set(key, { keys, epoch: this.compileEpoch });
    return keys;
  }

  computeWriteSummary(className, name, descriptor, inProgress, instance = false) {
    if (className === 'java/lang/Math') return EMPTY_WRITE_SET;
    if (className === 'java/lang/System' &&
        (name === 'currentTimeMillis' || name === 'nanoTime')) {
      return EMPTY_WRITE_SET;
    }
    const cd = this.jvm.classes[className];
    const clsAst = cd && cd.ast && cd.ast.classes[0];
    if (!clsAst) return null;
    const method = clsAst.items.filter((i) => i.type === 'method').map((i) => i.method)
      .find((m) => m.name === name && m.descriptor === descriptor);
    if (!method || (method.flags || []).includes('static') !== !instance) return null;
    const code = method.attributes && method.attributes.find((a) => a.type === 'code');
    if (!code) return null;
    const codeItems = code.code.codeItems;
    // Exception reporters are entered only by the JVM exception dispatcher;
    // they are not normal successors of the protected bytecodes. Summarize
    // the verifier-reachable normal graph so a handler-only StringBuilder or
    // wrapper call does not make an otherwise pure arithmetic helper appear
    // to mutate arbitrary caller state. If the generic verifier cannot prove
    // the graph, retain the previous conservative whole-method scan.
    let normalDepths = null;
    const jit = this.jvm.jit;
    if (jit && typeof jit.computeStackDepths === 'function') {
      const labels = new Map();
      codeItems.forEach((item, index) => {
        if (!item?.labelDef) return;
        const label = item.labelDef.endsWith(':')
          ? item.labelDef.slice(0, -1) : item.labelDef;
        labels.set(label, index);
      });
      normalDepths = jit.computeStackDepths(codeItems, labels);
    }
    const keys = new Set();
    for (let index = 0; index < codeItems.length; index += 1) {
      if (normalDepths && normalDepths[index] === undefined) continue;
      const item = codeItems[index];
      if (!item.instruction) continue;
      const op = getOp(item.instruction);
      if (op === 'putfield' || op === 'putstatic') {
        const [, , [fieldName, fieldDesc]] = item.instruction.arg;
        keys.add(`${fieldName}:${fieldDesc}`);
      } else if (op === 'invokestatic') {
        const [, calleeClass, [calleeName, calleeDesc]] = item.instruction.arg;
        const sub = this.staticWriteSummary(calleeClass, calleeName, calleeDesc, inProgress);
        if (sub === null) return null;
        for (const k of sub) keys.add(k);
      } else if (op && op.startsWith('invoke')) {
        return null; // virtual/interface/special/dynamic: unknown target
      }
    }
    return keys.size ? keys : EMPTY_WRITE_SET;
  }

  // Whether a callee whose last as-callee compile was deferred should be
  // tried again now. See the deferral in compile().
  calleeRetryAllowed(st) {
    if (st.calleeDeferredEpoch === undefined) return true;
    if (st.calleeDeferredEpoch === this.compileEpoch) return false;
    if (st.calleeBlockers && st.calleeBlockers.length &&
        this.blockersResolved(st.calleeBlockers, st.calleeBlockerSig)) {
      return true;
    }
    if (st.retryNotBeforeMs !== undefined && nowMs() < st.retryNotBeforeMs) return false;
    if (st.calleeRetryEpoch !== undefined) {
      return this.compileEpoch >= st.calleeRetryEpoch;
    }
    return true;
  }

  // Every named blocker is now ready/initialized/resolved, and at least one
  // of them was not when the deferral was recorded.
  blockersResolved(blockers, recordedSig) {
    const sig = this.blockerSignature(blockers);
    return sig !== recordedSig && !/[01]/.test(sig);
  }

  findReadyStatic(className, name, descriptor, allowPartial = false) {
    const cd = this.jvm.classes[className];
    const clsAst = cd && cd.ast && cd.ast.classes[0];
    if (!clsAst) return null;
    const method = clsAst.items.filter((i) => i.type === 'method').map((i) => i.method)
      .find((m) => m.name === name && m.descriptor === descriptor);
    if (!method || !(method.flags || []).includes('static')) return null;
    // ACC_SYNCHRONIZED is implied by the flag, not by bytecode, so the monitor
    // only exists on the interpreter's frame path. A linked call runs the body
    // with no frame at all, which would silently drop the lock.
    if ((method.flags || []).includes('synchronized')) return null;
    let st = this.state.get(method);
    if (!st) st = this.methodState({ method });
    if (!st.method) st.method = method; // partial-link deopts materialize a Frame
    if (st.status === 'cold' && this.calleeRetryAllowed(st)) {
      const hasClassInitializer = clsAst.items
        .filter((i) => i.type === 'method')
        .some((i) => i.method.name === '<clinit>');
      // Linking must not bypass an observable class initializer. Classes with
      // no <clinit> are safe because their initialization has no Java code.
      if (!hasClassInitializer || this.jvm.classInitializationState.get(className) === 'INITIALIZED') {
        this.compile({ method, className }, st, { asCallee: true });
      }
    }
    if (!st || st.status !== 'ready') return null;
    const cm = (st.callee || st).meta;
    if (cm.boxedCount) return null;
    // speculative modules are entered only through prepare(), whose epoch
    // check invalidates them; a captured link would outlive that check
    // (guard-elided `this` sites are speculative with speculations === 0)
    if (cm.speculations || (cm.specSites && cm.specSites.length)) return null;
    if (cm.fullyCompiled || cm.normalFlowFullyCompiled) return st;
    // partial callees deopt on demoted blocks; the entry block at least must
    // run in wasm or every call would deopt immediately
    return allowPartial && cm.externalEntry.has(0) ? st : null;
  }

  // Instance-method counterpart of findReadyStatic for devirtualized sites.
  // No <clinit> gate: an instance method only runs on an existing object,
  // whose class was initialized at instantiation, so linking cannot bypass
  // an observable class initializer.
  findReadyInstance(className, name, descriptor) {
    const cd = this.jvm.classes[className];
    const clsAst = cd && cd.ast && cd.ast.classes[0];
    if (!clsAst) return null;
    const method = clsAst.items.filter((i) => i.type === 'method').map((i) => i.method)
      .find((m) => m.name === name && m.descriptor === descriptor);
    if (!method) return null;
    const flags = method.flags || [];
    if (flags.includes('static') || flags.includes('abstract') || flags.includes('native')) return null;
    // See findReadyStatic: a linked call has no frame, so it has no monitor.
    if (flags.includes('synchronized')) return null;
    let st = this.state.get(method);
    if (!st) st = this.methodState({ method });
    if (!st.method) st.method = method;
    st.targetClassName = className;
    if (st.status === 'cold' && this.calleeRetryAllowed(st)) {
      this.compile({ method, className }, st, { asCallee: true });
    }
    if (!st || st.status !== 'ready') return null;
    const cm = (st.callee || st).meta;
    if (cm.boxedCount) return null;
    // Guarded speculative modules are excluded like findReadyStatic. Guard-
    // elided modules (specSites without speculations) ARE returned: every
    // instance-dispatch runner revalidates them per call
    // (revalidateNestedCallee) and has a miss/deopt path when the baked
    // world grew, while raw direct links exclude them at eligibility.
    if (cm.speculations) return null;
    if (cm.fullyCompiled || cm.normalFlowFullyCompiled) return st;
    return cm.externalEntry.has(0) ? st : null;
  }

  // Captured nested-dispatch targets bypass prepare()'s speculation gate.
  // Before running one, re-check its baked class world: refresh the epoch
  // when every speculated cone is unchanged (the common case), invalidate
  // the module when one grew — the caller takes its existing miss/deopt
  // path and the next compile rebuilds against the new world. Also rejects
  // a target another path already invalidated (meta gone).
  revalidateNestedCallee(st) {
    const meta = (st.callee || st).meta;
    if (!meta) return false;
    if (!meta.specSites || !meta.specSites.length) return true;
    if (meta.specEpoch === (this.jvm.classEpoch || 0)) return true;
    if (revalidateSpeculations(this.jvm, this.hierarchy, meta.specSites)) {
      meta.specEpoch = this.jvm.classEpoch || 0;
      if (meta.specok) meta.specok.value = 1;
      return true;
    }
    st.status = 'cold';
    st.entries = 0;
    st.retryAfter = 1;
    st.meta = null;
    st.run = null;
    st.osr = null;
    st.callee = null;
    return false;
  }

  // A virtual-call import is built from the classes loaded at compile time.
  // When a receiver from a later-loaded class reaches that import, resolve
  // its exact immutable implementation and install it into this call site's
  // map. Continuing inside wasm is sound only when the new implementation's
  // transitive field writes are covered by the cache kills already emitted
  // in the caller; otherwise retain the original deopt-before-side-effects
  // behavior. `null` means the caller already kills every field cache.
  resolveLateInstanceTarget(owner, name, descriptor, runtimeClass, allowedWrites) {
    if (!this.lateInstanceTargetsEnabled) return null;
    this.lateInstanceTargetAttempts += 1;
    const resolved = this.hierarchy.resolveDispatch(owner, name, descriptor);
    const impl = resolved && resolved.targets.get(runtimeClass);
    if (!impl) {
      this.lateInstanceTargetNotReady += 1;
      return null;
    }
    const targetWrites = this.instanceWriteSummary(impl.className, name, descriptor);
    if (allowedWrites !== null &&
        (targetWrites === null || [...targetWrites].some((key) => !allowedWrites.has(key)))) {
      this.lateInstanceTargetWriteRejects += 1;
      return null;
    }
    const st = this.findReadyInstance(impl.className, name, descriptor);
    if (!st) {
      this.lateInstanceTargetNotReady += 1;
      return null;
    }
    const meta = (st.callee || st).meta;
    if (st.linkVetoed && !meta.fullyCompiled) {
      this.lateInstanceTargetNotReady += 1;
      return null;
    }
    this.lateInstanceTargetInstalls += 1;
    return st;
  }

  dumpStats() {
    console.error(`[wasmjit] late instance targets: attempts=${this.lateInstanceTargetAttempts} ` +
      `installs=${this.lateInstanceTargetInstalls} writeRejects=${this.lateInstanceTargetWriteRejects} ` +
      `notReady=${this.lateInstanceTargetNotReady}`);
    for (const st of this.compiled) {
      console.error(`[wasmjit] ${st.key}: runs=${st.runs} exits=${st.exits}` +
        `${st.fuelExits ? ` fuelExits=${st.fuelExits}` : ''}${st.meta && st.meta.structured ? ' structured' : ''}`);
    }
  }
}

module.exports = WasmJit;
module.exports._test = {
  capturesBooleanStatic, isNoOpExceptionHandler, toWasmValue,
  wasmFunctionNameSection, wasmProfilerName, T,
};
