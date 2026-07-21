'use strict';

// Structured wasm backend: lowers the shared SSA IR (analysis/opgraph/ssa)
// through the structurer's region tree into real wasm block/loop/if control
// flow — no br_table dispatcher, no per-block fuel prologue, no carry locals.
// Fuel is decremented once per loop iteration at the loop header; a fuel
// exhaustion exit spills the header's reaching slot defs + entry stack and
// returns the header's item index, exactly matching the dispatcher tier's
// resume protocol. The produced meta is byte-compatible with WasmJit's
// linking contract (externalEntry={0}, run(slots.., blk(ignored), fuel)->i32,
// -1 = returned via box.ret).
//
// Coverage mirrors the dispatcher's per-block demotion: blocks intersecting
// a live (non-no-op) exception-handler range, and blocks whose body or
// terminator uses an op this backend cannot emit (athrow, monitors,
// allocation, checkcast/instanceof, string/class constants, virtual
// invokes), become exit stubs — spill the block's reaching slot defs + entry
// stack and return its item index; the interpreter (and the dispatcher OSR
// module kept alongside) take over from there. invokestatic binds directly
// to fully-compiled wasm callees. Whole-method rejection remains only for
// missing/irreducible CFGs, SSA rejection, or a demoted entry block.

const { buildCfgFromCode, structure, IrreducibleError } = require('../decompiler/structurer');
const { buildSsa } = require('../analysis/opgraph/ssa');
const {
  T, OP, TRUNC_SAT, uleb, sleb, f32bytes, f64bytes,
  wasmProfilerName, parseMethodDescriptor, descToWasm,
  BRANCH_COND, BRANCH_ZERO, ICONST, BIN_OPS, ARRAY_LOAD, ARRAY_STORE,
  Unsupported, sig, assembleModule, liveExceptionRanges,
} = require('./wasmShared');
const {
  addRuntimeImports, pushImportFor, addArrayImports, addFieldImport, addMathImport,
  addTimeImport,
} = require('./wasmRuntimeImports');
const { inlineCalls } = require('./wasmInline');
const { runtimeClassName } = require('../instructions/object');

const KIND_T = { I: T.i32, J: T.i64, F: T.f32, D: T.f64, A: T.ref };
// Linear-heap element access per bytecode op: wasm load/store opcode and the
// element size shift. baload/bastore also serve boolean arrays (Int8Array,
// values 0/1); caload is the only unsigned load (Java char).
const HEAP_LOAD = {
  iaload: { op: 'i32_load', shift: 2, t: T.i32 },
  laload: { op: 'i64_load', shift: 3, t: T.i64 },
  faload: { op: 'f32_load', shift: 2, t: T.f32 },
  daload: { op: 'f64_load', shift: 3, t: T.f64 },
  baload: { op: 'i32_load8_s', shift: 0, t: T.i32 },
  caload: { op: 'i32_load16_u', shift: 1, t: T.i32 },
  saload: { op: 'i32_load16_s', shift: 1, t: T.i32 },
};
const HEAP_STORE = {
  iastore: { op: 'i32_store', shift: 2, t: T.i32 },
  lastore: { op: 'i64_store', shift: 3, t: T.i64 },
  fastore: { op: 'f32_store', shift: 2, t: T.f32 },
  dastore: { op: 'f64_store', shift: 3, t: T.f64 },
  bastore: { op: 'i32_store8', shift: 0, t: T.i32 },
  castore: { op: 'i32_store16', shift: 1, t: T.i32 },
  sastore: { op: 'i32_store16', shift: 1, t: T.i32 },
};
const LCONST = { lconst_0: 0n, lconst_1: 1n };
const FCONST = { fconst_0: 0, fconst_1: 1, fconst_2: 2 };
const DCONST = { dconst_0: 0, dconst_1: 1 };
const CONVERT = {
  i2l: [OP.i64_extend_i32_s], l2i: [OP.i32_wrap_i64],
  i2f: [OP.f32_convert_i32_s], i2d: [OP.f64_convert_i32_s],
  l2f: [OP.f32_convert_i64_s], l2d: [OP.f64_convert_i64_s],
  f2d: [OP.f64_promote_f32], d2f: [OP.f32_demote_f64],
  f2i: TRUNC_SAT.i32_f32, f2l: TRUNC_SAT.i64_f32,
  d2i: TRUNC_SAT.i32_f64, d2l: TRUNC_SAT.i64_f64,
  i2b: [OP.i32_extend8_s], i2s: [OP.i32_extend16_s],
};

class StructuredWasmCompiler {
  constructor(jvm, method, className, wasmJit) {
    this.jvm = jvm;
    this.method = method;
    this.className = className;
    this.wasmJit = wasmJit;
    this.importFns = [];
    this.importDecls = [];
    this.importIndexByName = new Map();
    this.box = { frame: null, ret: undefined };
  }

  addImport(name, params, results, fn) {
    if (this.importIndexByName.has(name)) return this.importIndexByName.get(name);
    const idx = this.importDecls.length;
    this.importDecls.push({ name, params, results });
    this.importFns.push(fn);
    this.importIndexByName.set(name, idx);
    return idx;
  }

  translate() {
    const inlineEnabled = process.env.JVM_WASM_INLINE !== '0';
    try {
      return this.translateWith(inlineEnabled);
    } catch (err) {
      // Inlining can create blocks with no interpreter resume pc; if one of
      // those ends up needing an exit stub, redo the method without inlining.
      if (!(err instanceof Unsupported) || !this.didInline) throw err;
      return new StructuredWasmCompiler(this.jvm, this.method, this.className, this.wasmJit)
        .translateWith(false);
    }
  }

  translateWith(inline) {
    const codeAttr = this.method.attributes.find((a) => a.type === 'code');
    if (!codeAttr) throw new Unsupported('no code');
    let items = codeAttr.code.codeItems;
    const table = codeAttr.code.exceptionTable || [];
    this.origIdx = null;
    this.deoptStubs = null;
    let inlinedCalls = 0;
    let speculations = 0;
    let specSites = null;
    if (inline) {
      const instanceInline = process.env.JVM_WASM_INSTANCE_INLINE !== '0';
      const expanded = inlineCalls(this.jvm, codeAttr, {
        hierarchy: instanceInline && this.wasmJit ? this.wasmJit.hierarchy : null,
        callerClassName: this.className,
      });
      if (expanded) {
        items = expanded.items;
        this.origIdx = expanded.origIdx;
        this.deoptStubs = expanded.deoptStubs;
        this.didInline = true;
        inlinedCalls = expanded.inlined;
        speculations = expanded.speculations;
        specSites = expanded.specSites;
      }
    }

    const cfg = buildCfgFromCode(items);
    if (!cfg) throw new Unsupported('no cfg');
    let structured;
    try {
      structured = structure(cfg);
    } catch (err) {
      if (err instanceof IrreducibleError) throw new Unsupported('irreducible');
      throw err;
    }

    const fn = buildSsa(
      { codeItems: items, exceptionTable: table, method: this.method },
      { cfg },
    );
    if (fn.rejected) throw new Unsupported(`ssa: ${fn.rejected}`);
    this.fn = fn;
    this.cfg = cfg;
    this.items = items;

    // Guard-miss deopt stubs from inlined instance calls: blocks that exit to
    // the interpreter at the ORIGINAL call site with [recv, args...] rebuilt
    // from the argument-store slots.
    this.deoptBlocks = new Map();
    if (this.deoptStubs && this.deoptStubs.size) {
      const blockOfFirst = new Map();
      for (const block of cfg.blocks) blockOfFirst.set(block.insns[0], block.id);
      for (const [idx, stub] of this.deoptStubs) {
        const id = blockOfFirst.get(idx);
        if (id === undefined) throw new Unsupported('deopt stub not at block start');
        this.deoptBlocks.set(id, stub);
      }
    }

    // wasm locals: params (slot order), blk, fuel, then one local per value
    this.paramSlots = fn.params.map((p) => ({ slot: p.imm.slot, t: KIND_T[p.kind] }));
    if (this.paramSlots.some((p) => p.t === undefined)) throw new Unsupported('param kind');
    this.localOf = new Map();
    fn.params.forEach((p, i) => this.localOf.set(p, i));
    this.blkLocal = fn.params.length;
    this.fuelLocal = fn.params.length + 1;
    this.declared = [];
    this.nextLocal = fn.params.length + 2;

    addRuntimeImports(this, this.box);
    addArrayImports(this, this.method.name);

    // Linear-heap array caches: per receiver SSA value, three locals holding
    // the array's byte base (-1 = null or not heap-backed), length, and a
    // filled flag. Base and length are immutable per array object, so these
    // are never killed. Element access inlines to a bounds check + raw
    // load/store when base >= 0, else takes the aget/aset import path.
    this.heap = (process.env.JVM_WASM_HEAP_ARRAYS !== '0' && this.jvm.wasmHeap) || null;
    this.arrayCaches = new Map();
    this.usedHeap = false;

    // Field-value caches (ported from the dispatcher tier, SSA-keyed).
    // Instance caches key on the receiver's SSA value id: an SSA value is
    // immutable for the whole run, so — unlike the dispatcher's slot
    // provenance — no kills on local stores are ever needed. Kills remain at
    // putfield/putstatic (matching field) and at linked static callees
    // (transitive write summary; unknowable summary kills all). No other
    // import in this tier runs guest code or a thread switch. The demotion
    // dry-run below doubles as the discovery pass: every fill site registers
    // its entry before real emission, so kill sites always see the full set.
    this.fieldCaches = new Map();

    const localFor = (value) => {
      let idx = this.localOf.get(value);
      if (idx === undefined) {
        const t = KIND_T[value.kind];
        if (t === undefined) throw new Unsupported(`value kind ${value.kind} (${value.op})`);
        idx = this.nextLocal++;
        this.declared.push(t);
        this.localOf.set(value, idx);
      }
      return idx;
    };
    for (const block of fn.blocks) {
      if (!fn.reachable.has(block.id)) continue;
      for (const phi of block.phis) {
        if (KIND_T[phi.kind] === undefined) {
          // Dead frame-slot join (kind conflict / never loaded): no local, no
          // copies — it must also never be spilled.
          continue;
        }
        localFor(phi);
      }
      for (const node of block.body) {
        if (node.kind !== 'V' && KIND_T[node.kind] !== undefined) localFor(node);
      }
    }

    // Per-block demotion: live handler ranges first, then a dry-run of every
    // tree block's body + terminator — any Unsupported demotes just that
    // block to an exit stub instead of rejecting the method.
    const labelIndex = new Map();
    items.forEach((it, i) => {
      if (it.labelDef) labelIndex.set(it.labelDef.slice(0, -1), i);
    });
    const treeBlocks = collectTreeBlocks(structured.tree);
    this.demoted = new Map();
    // labelIndex is in EXPANDED item space; hand liveExceptionRanges a code
    // view whose codeItems match, or handlers after a splice point read the
    // wrong items and misclassify as live (spurious demotions).
    const liveRanges = liveExceptionRanges(
      this.jvm, { ...codeAttr.code, codeItems: items }, labelIndex,
    );
    if (liveRanges.length) {
      for (const id of treeBlocks) {
        const insns = cfg.blocks[id].insns;
        const s = insns[0];
        const e = insns[insns.length - 1];
        if (liveRanges.some(([rs, re]) => s < re && e >= rs)) {
          this.demoted.set(id, 'live handler range');
        }
      }
    }
    for (const id of treeBlocks) {
      if (this.demoted.has(id) || this.deoptBlocks.has(id)) continue;
      try {
        const scratch = [];
        this.emitBlockBody(id, scratch);
        this.dryRunTerm(id, scratch);
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
        this.demoted.set(id, err.message);
      }
    }
    if (this.demoted.has(cfg.entry)) {
      throw new Unsupported(`entry demoted: ${this.demoted.get(cfg.entry)}`);
    }

    const body = [];
    // Entry seed: a loop-header entry joins params with back edges; phi arg 0
    // is the seed (params/undef), copied once at function start.
    const entryBlock = fn.blocks[cfg.entry];
    if (entryBlock.phis.length && entryBlock.predIds[0] === 'entry') {
      this.emitParallelPhiCopies(body, entryBlock, 0);
    }
    this.frames = [];
    this.lowerNode(structured.tree, body, { curBlock: cfg.entry });
    body.push(OP.unreachable);
    body.push(OP.end); // function

    const bytes = assembleModule({
      importDecls: this.importDecls,
      mainParams: [...this.paramSlots.map((p) => p.t), T.i32, T.i32],
      mainResults: [T.i32],
      declared: this.declared,
      body,
      profilerName: wasmProfilerName(this.className, this.method),
      importMemory: this.usedHeap,
    });

    const blockOfItem = new Map();
    const supportedBlocks = new Set();
    for (const block of cfg.blocks) {
      // keys are ORIGINAL item indices (frame.pc space); blocks that begin
      // inside inlined code have no external identity and are skipped
      const orig = this.origIdx ? this.origIdx[block.insns[0]] : block.insns[0];
      if (orig !== undefined && orig >= 0 && !blockOfItem.has(orig)) {
        blockOfItem.set(orig, block.id);
      }
      if (treeBlocks.has(block.id) && !this.demoted.has(block.id) &&
          !this.deoptBlocks.has(block.id)) {
        supportedBlocks.add(block.id);
      }
    }
    const env = {};
    this.importDecls.forEach((d, i) => { env[d.name] = this.importFns[i]; });
    if (this.usedHeap) env.mem = this.heap.memory;
    // Deopt stubs exit mid-method needing a real frame, so modules that have
    // them must take the partial-callee protocol (and are never pinned).
    const normalFlowFullyCompiled = this.demoted.size === 0 && this.deoptBlocks.size === 0;
    return {
      bytes,
      importObject: { env },
      box: this.box,
      paramSlots: this.paramSlots,
      retChar: parseMethodDescriptor(this.method.descriptor).ret,
      blockOfItem,
      supportedBlocks,
      externalEntry: new Set([0]),
      demoteReasons: this.demoted,
      blockCount: cfg.n,
      fullyCompiled: normalFlowFullyCompiled && table.length === 0,
      normalFlowFullyCompiled,
      boxedCount: 0,
      fieldCacheCount: this.fieldCaches.size,
      structured: true,
      inlinedCalls,
      // CHA instanceof guards bake the compile-time world; the jit re-checks
      // specEpoch before every entry, revalidates the sites when the world
      // grew, and recompiles only when a speculated cone actually changed.
      speculations,
      specSites,
      specEpoch: this.jvm.classEpoch || 0,
      deoptStubCount: this.deoptBlocks.size,
      arrayCacheCount: this.arrayCaches.size,
    };
  }

  // Validates a block's terminator lowering without emitting into the real
  // body — mirrors what lowerNode will ask of this block later.
  dryRunTerm(id, out) {
    const term = this.cfg.term[id];
    if (!term) return;
    if (term.kind === 'return') { this.emitTermIfFinal(id, out); return; }
    if (term.cases) { out.push(...this.useOf(this.blockOf(id).term.args[0])); return; }
    if (term.taken !== undefined) this.emitCondition(id, out);
  }

  // ---- tree lowering ----

  lowerNode(node, out, env) {
    if (!node) return;
    switch (node.t) {
      case 'seq':
        for (const child of node.body) this.lowerNode(child, out, env);
        return;
      case 'straight': {
        env.curBlock = node.block;
        if (this.deoptBlocks.has(node.block)) {
          this.emitSpillResume(node.block, out, this.deoptBlocks.get(node.block));
          return;
        }
        if (this.demoted.has(node.block)) {
          // Exit stub: hand the block to the interpreter (the dispatcher OSR
          // module picks the method back up at the next supported block).
          this.emitSpillResume(node.block, out);
          return;
        }
        this.emitBlockBody(node.block, out);
        const term = this.cfg.term[node.block];
        // Edges are copied at their SOURCE context, before whatever encodes
        // the transfer (an inlined subtree, break, or continue) runs.
        if (term.kind === 'return') this.emitTermIfFinal(node.block, out);
        else if (term.kind === 'goto' || term.kind === 'fall') {
          this.emitEdge(node.block, term.target, out);
        }
        return;
      }
      case 'block': {
        out.push(OP.block, 0x40);
        this.frames.push({ label: node.label });
        this.lowerNode(node.body, out, env);
        this.frames.pop();
        out.push(OP.end);
        return;
      }
      case 'loop': {
        const header = headerOfLabel(node.label);
        out.push(OP.loop, 0x40);
        this.frames.push({ label: node.label });
        this.emitFuelCheck(header, out);
        this.lowerNode(node.body, out, env);
        this.frames.pop();
        out.push(OP.end);
        return;
      }
      case 'if': {
        const from = node.block;
        // A demoted branching block already emitted its exit stub in the
        // 'straight' case; its arms are unreachable and the wasm stack is
        // empty between nodes, so skipping them entirely stays valid.
        if (this.demoted.has(from)) return;
        this.emitCondition(from, out);
        out.push(OP.if, 0x40);
        this.frames.push({ label: null });
        this.emitEdge(from, this.cfg.term[from].taken, out);
        this.lowerNode(node.then, out, { curBlock: from });
        out.push(OP.else);
        this.emitEdge(from, this.cfg.term[from].fall, out);
        this.lowerNode(node.els, out, { curBlock: from });
        this.frames.pop();
        out.push(OP.end);
        return;
      }
      case 'switch': {
        const from = node.block;
        if (this.demoted.has(from)) return;
        const term = this.cfg.term[from];
        const selector = this.useOf(this.blockOf(from).term.args[0]);
        // if/else chain; each arm is already a break/continue/inline subtree
        const lowerArm = (index) => {
          if (index >= node.cases.length) {
            if (node.dflt) {
              this.emitEdge(from, term.default, out);
              this.lowerNode(node.dflt, out, { curBlock: from });
            } else {
              out.push(OP.unreachable);
            }
            return;
          }
          out.push(...selector, OP.i32_const, ...sleb(term.cases[index].key), OP.i32_eq);
          out.push(OP.if, 0x40);
          this.frames.push({ label: null });
          this.emitEdge(from, term.cases[index].target, out);
          this.lowerNode(node.cases[index].body, out, { curBlock: from });
          out.push(OP.else);
          lowerArm(index + 1);
          this.frames.pop();
          out.push(OP.end);
        };
        lowerArm(0);
        return;
      }
      case 'break':
      case 'continue':
        // Phi copies for this edge were already emitted by the source context
        // (straight goto/fall, if arm, or switch arm) — just branch.
        out.push(OP.br, ...uleb(this.depthOf(node.label)));
        return;
      default:
        throw new Unsupported(`tree node ${node.t}`);
    }
  }

  blockOf(id) { return this.fn.blocks[id]; }

  depthOf(label) {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      if (this.frames[i].label === label) return this.frames.length - 1 - i;
    }
    throw new Unsupported(`unresolved label ${label}`);
  }

  // Edge from -> target: parallel phi copies for the target's join values.
  emitEdge(from, target, out) {
    if (target == null) return;
    const block = this.blockOf(target);
    if (!block || !block.phis.length) return;
    const argIndex = block.predIds.indexOf(from);
    if (argIndex < 0) throw new Unsupported(`edge ${from}->${target} not in preds`);
    this.emitParallelPhiCopies(out, block, argIndex);
  }

  // Push all sources, then set targets in reverse: the wasm value stack is
  // the cycle-breaking temporary, so swaps/permutations are safe.
  emitParallelPhiCopies(out, block, argIndex) {
    const copies = [];
    for (const phi of block.phis) {
      const t = KIND_T[phi.kind];
      if (t === undefined) continue; // dead conflicted slot join
      const arg = phi.args[argIndex];
      if (!arg || arg === phi) continue;
      copies.push({ phi, arg, t });
    }
    for (const { arg, t } of copies) {
      // An unkinded arg is a conflicted slot join that was never loaded on
      // this path: verified bytecode cannot observe a slot whose types
      // conflict at the join, so the value riding this edge is dead garbage
      // and a zero constant is equivalent (same rule as slotDefsIn spills).
      if (arg.op === 'undef' || KIND_T[arg.kind] === undefined) out.push(...zeroConst(t));
      else out.push(OP.local_get, ...uleb(this.mustLocal(arg)));
    }
    for (let i = copies.length - 1; i >= 0; i -= 1) {
      out.push(OP.local_set, ...uleb(this.mustLocal(copies[i].phi)));
    }
    // a phi assignment rebinds its local (loop-carried receivers): caches
    // keyed on the phi describe the previous iteration's object
    for (const { phi } of copies) out.push(...this.cacheKillsFor(phi.id));
  }

  mustLocal(value) {
    const idx = this.localOf.get(value);
    if (idx === undefined) throw new Unsupported(`no local for ${value.op} kind ${value.kind}`);
    return idx;
  }

  useOf(value) {
    return [OP.local_get, ...uleb(this.mustLocal(value))];
  }

  emitFuelCheck(header, out) {
    out.push(
      OP.local_get, ...uleb(this.fuelLocal),
      OP.i32_const, ...sleb(1), OP.i32_sub,
      OP.local_tee, ...uleb(this.fuelLocal),
      OP.i32_const, ...sleb(0), OP.i32_le_s,
      OP.if, 0x40,
    );
    this.emitSpillResume(header, out);
    out.push(OP.end);
  }

  // Spill the block's reaching slot defs into frame.locals, push its entry
  // stack into frame.stack, and resume interpretation at the block. Shared by
  // fuel-exhaustion exits (inside the fuel if), demoted-block exit stubs, and
  // — with `stub` — inlined-call deopt stubs, which additionally push the
  // original invoke's operands [recv, args...] (read from the argument-store
  // slots; the entry stack holds only whatever sat UNDER them) and resume at
  // the original call-site pc so the interpreter re-executes the invoke.
  emitSpillResume(blockId, out, stub = null) {
    const block = this.blockOf(blockId);
    const spills = [];
    for (const [slot, value] of block.slotDefsIn || []) {
      const t = KIND_T[value.kind];
      if (t === undefined || value.op === 'undef') continue; // dead or conflicted
      spills.push({ slot, value, t });
    }
    if (spills.length) {
      const slots = spills.map((s) => s.slot);
      const box = this.box;
      const idx = this.addImport(
        `spill_h${blockId}`, spills.map((s) => s.t), [],
        (...values) => {
          const locals = box.frame.locals;
          for (let i = 0; i < slots.length; i += 1) locals[slots[i]] = values[i];
        },
      );
      for (const { value } of spills) out.push(...this.useOf(value));
      out.push(OP.call, ...uleb(idx));
    }
    for (const value of block.entryStack) {
      const t = KIND_T[value.kind];
      if (t === undefined) throw new Unsupported('unkinded entry stack at exit');
      out.push(...this.useOf(value), OP.call, ...uleb(pushImportFor(this, t)));
    }
    if (stub) {
      const defs = block.slotDefsIn || new Map();
      for (const slot of stub.valueSlots) {
        const def = defs.get(slot);
        const t = def && def.op !== 'undef' ? KIND_T[def.kind] : undefined;
        if (t === undefined) throw new Unsupported('deopt stub operand unavailable');
        out.push(...this.useOf(def), OP.call, ...uleb(pushImportFor(this, t)));
      }
      out.push(OP.i32_const, ...sleb(stub.resumeIdx), OP.return);
      return;
    }
    out.push(OP.i32_const, ...sleb(this.resumeItemOf(blockId)), OP.return);
  }

  // The ORIGINAL caller item index the interpreter resumes at for this
  // block. Blocks that begin inside inlined callee code have none.
  resumeItemOf(blockId) {
    const first = this.cfg.blocks[blockId].insns[0];
    const orig = this.origIdx ? this.origIdx[first] : first;
    if (orig === undefined || orig < 0) throw new Unsupported('resume inside inlined code');
    return orig;
  }

  emitCondition(blockId, out) {
    const term = this.blockOf(blockId).term;
    const op = term.insnOp;
    const args = term.args;
    if (BRANCH_COND[op] !== undefined) {
      out.push(...this.useOf(args[0]), ...this.useOf(args[1]), BRANCH_COND[op]);
      return;
    }
    if (op in BRANCH_ZERO) {
      if (op === 'ifne') { out.push(...this.useOf(args[0])); return; }
      if (op === 'ifeq') { out.push(...this.useOf(args[0]), OP.i32_eqz); return; }
      out.push(...this.useOf(args[0]), OP.i32_const, ...sleb(0), BRANCH_ZERO[op]);
      return;
    }
    if (op === 'ifnull') { out.push(...this.useOf(args[0]), OP.ref_is_null); return; }
    if (op === 'ifnonnull') { out.push(...this.useOf(args[0]), OP.ref_is_null, OP.i32_eqz); return; }
    if (op === 'if_acmpeq' || op === 'if_acmpne') {
      out.push(...this.useOf(args[0]), ...this.useOf(args[1]),
        OP.call, ...uleb(this.importIndexByName.get('ref_eq')));
      if (op === 'if_acmpne') out.push(OP.i32_eqz);
      return;
    }
    throw new Unsupported(`condition ${op}`);
  }

  emitTermIfFinal(blockId, out) {
    const term = this.blockOf(blockId).term;
    if (term.kind !== 'return') return;
    const op = term.insnOp;
    if (op === 'athrow') throw new Unsupported('athrow');
    if (op && op !== 'return') {
      const value = term.args[0];
      const t = KIND_T[value.kind];
      if (t === undefined) throw new Unsupported('return kind');
      out.push(...this.useOf(value), OP.call,
        ...uleb(this.importIndexByName.get(`ret_${sig(t)}`)));
    }
    out.push(OP.i32_const, ...sleb(-1), OP.return);
  }

  emitBlockBody(blockId, out) {
    const block = this.blockOf(blockId);
    for (const node of block.body) {
      this.emitNode(node, out);
    }
  }

  emitNode(node, out) {
    const op = node.op;
    const use = (i) => this.useOf(node.args[i]);
    const finish = () => {
      if (node.kind !== 'V') {
        out.push(OP.local_set, ...uleb(this.mustLocal(node)));
        // this value's local now holds a fresh (re)computation — caches
        // keyed on it describe the previous one and must refill
        out.push(...this.cacheKillsFor(node.id));
      }
    };

    // constants
    if (op in ICONST) { out.push(OP.i32_const, ...sleb(ICONST[op])); return finish(); }
    if (op in LCONST) { out.push(OP.i64_const, ...sleb(LCONST[op])); return finish(); }
    if (op in FCONST) { out.push(OP.f32_const, ...f32bytes(FCONST[op])); return finish(); }
    if (op in DCONST) { out.push(OP.f64_const, ...f64bytes(DCONST[op])); return finish(); }
    if (op === 'bipush' || op === 'sipush') {
      out.push(OP.i32_const, ...sleb(Number(node.imm))); return finish();
    }
    if (op === 'aconst_null') { out.push(OP.ref_null, T.ref); return finish(); }
    if (op === 'ldc' || op === 'ldc_w' || op === 'ldc2_w') {
      out.push(...this.constSeq(op, node)); return finish();
    }

    if (op === 'iinc') {
      out.push(...use(0), OP.i32_const, ...sleb(node.imm.delta), OP.i32_add);
      return finish();
    }

    // arithmetic
    if (BIN_OPS[op]) { out.push(...use(0), ...use(1), BIN_OPS[op][1]); return finish(); }
    if (op === 'idiv' || op === 'irem' || op === 'ldiv' || op === 'lrem') {
      const wide = op[0] === 'l';
      out.push(...use(1), wide ? OP.i64_eqz : OP.i32_eqz, OP.if, 0x40,
        OP.call, ...uleb(this.importIndexByName.get('err_div0')), OP.end);
      out.push(...use(0), ...use(1),
        { idiv: OP.i32_div_s, irem: OP.i32_rem_s, ldiv: OP.i64_div_s, lrem: OP.i64_rem_s }[op]);
      return finish();
    }
    if (op === 'lshl' || op === 'lshr' || op === 'lushr') {
      out.push(...use(0), ...use(1), OP.i64_extend_i32_s,
        { lshl: OP.i64_shl, lshr: OP.i64_shr_s, lushr: OP.i64_shr_u }[op]);
      return finish();
    }
    if (op === 'ineg') { out.push(OP.i32_const, ...sleb(0), ...use(0), OP.i32_sub); return finish(); }
    if (op === 'lneg') { out.push(OP.i64_const, ...sleb(0), ...use(0), OP.i64_sub); return finish(); }
    if (op === 'fneg') { out.push(...use(0), OP.f32_neg); return finish(); }
    if (op === 'dneg') { out.push(...use(0), OP.f64_neg); return finish(); }

    // comparisons
    if (op === 'lcmp') {
      out.push(...use(0), ...use(1), OP.i64_gt_s, ...use(0), ...use(1), OP.i64_lt_s, OP.i32_sub);
      return finish();
    }
    if (op === 'fcmpl' || op === 'fcmpg' || op === 'dcmpl' || op === 'dcmpg') {
      const wide = op[0] === 'd';
      const [gt, lt, ne] = wide
        ? [OP.f64_gt, OP.f64_lt, OP.f64_ne] : [OP.f32_gt, OP.f32_lt, OP.f32_ne];
      out.push(OP.i32_const, ...sleb(op.endsWith('g') ? 1 : -1));
      out.push(...use(0), ...use(1), gt, ...use(0), ...use(1), lt, OP.i32_sub);
      out.push(...use(0), ...use(0), ne, ...use(1), ...use(1), ne, OP.i32_or);
      out.push(OP.select);
      return finish();
    }

    // conversions
    if (CONVERT[op]) { out.push(...use(0), ...CONVERT[op]); return finish(); }
    if (op === 'i2c') { out.push(...use(0), OP.i32_const, ...sleb(0xffff), OP.i32_and); return finish(); }

    // arrays
    if (ARRAY_LOAD[op] !== undefined) {
      const t = ARRAY_LOAD[op];
      if (this.heap && HEAP_LOAD[op]) {
        out.push(...this.heapAccessSeq(node, HEAP_LOAD[op], null, t));
        return finish();
      }
      out.push(...use(0), ...use(1), OP.call,
        ...uleb(this.importIndexByName.get(`aget_${sig(t)}`)));
      return finish();
    }
    if (ARRAY_STORE[op] !== undefined) {
      const t = ARRAY_STORE[op];
      if (this.heap && HEAP_STORE[op]) {
        out.push(...this.heapAccessSeq(node, HEAP_STORE[op], use(2), t));
        return finish();
      }
      out.push(...use(0), ...use(1), ...use(2), OP.call,
        ...uleb(this.importIndexByName.get(`aset_${sig(t)}`)));
      return finish();
    }
    if (op === 'arraylength') {
      out.push(...use(0), OP.call, ...uleb(this.importIndexByName.get('alen')));
      return finish();
    }

    // fields
    if (op === 'getstatic' || op === 'getfield' || op === 'putstatic' || op === 'putfield') {
      const isGet = op[0] === 'g';
      const isStatic = op.endsWith('static');
      const field = addFieldImport(this, this.jvm, { arg: node.imm }, isStatic, isGet);
      const [, , [fieldName, descriptor]] = node.imm;
      const killKey = `${fieldName}:${descriptor}`;
      const caching = !this.wasmJit || this.wasmJit.fieldCacheEnabled !== false;
      if (isGet && caching) {
        const cacheKey = isStatic
          ? `s|${field.name}` : `f|${node.args[0].id}|${field.name}`;
        const entry = this.fieldCacheFor(cacheKey, field.t, killKey, isStatic ? 's' : 'f',
          isStatic ? null : node.args[0].id);
        // cached instance path skips the null check: a filled flag proves
        // this exact SSA value already loaded this field successfully
        const loadSeq = isStatic
          ? [OP.call, ...uleb(field.idx)]
          : [...use(0), OP.call, ...uleb(field.idx)];
        // dependent caches (arrays/fields keyed on this value) are killed on
        // the refill path only — a hit reproduces the cached value verbatim
        out.push(...this.cachedReadSeq(entry, loadSeq, this.cacheKillsFor(node.id)));
        if (node.kind !== 'V') out.push(OP.local_set, ...uleb(this.mustLocal(node)));
        return;
      }
      for (let i = 0; i < node.args.length; i += 1) out.push(...use(i));
      out.push(OP.call, ...uleb(field.idx));
      if (!isGet) {
        out.push(...this.killSeqWhere((entry) => (
          entry.kind === (isStatic ? 's' : 'f') && entry.killKey === killKey)));
      }
      return finish();
    }

    // calls: Math intrinsics, or direct binding to a fully-compiled callee
    if (op === 'invokestatic') {
      const call = this.staticCallImport(node);
      for (let i = 0; i < node.args.length; i += 1) out.push(...use(i));
      out.push(OP.call, ...uleb(call.idx));
      // kill only the caches the callee may transitively write (math/time
      // intrinsics carry no summary and write nothing); an unknowable
      // callee (null summary) may put any field or static
      if (call.writes === null) out.push(...this.killSeqWhere(() => true));
      else if (call.writes && call.writes.size) {
        out.push(...this.killSeqWhere((entry) => call.writes.has(entry.killKey)));
      }
      return finish();
    }

    // Casts compile only inside spliced callee bodies (those blocks have no
    // interpreter resume pc, so demotion is not an option there). Original-
    // method casts keep the demotion status quo: compiling them was measured
    // net-negative on the dispatcher tier (it unlocks tiny cast-bearing
    // callees whose import-dispatch overhead exceeds interpreting them).
    if (op === 'checkcast' || op === 'instanceof') {
      if (!this.origIdx || this.origIdx[node.itemIdx] !== -1) {
        throw new Unsupported(`op ${op}`);
      }
      out.push(...use(0), OP.call, ...uleb(this.castImport(op, node.imm)));
      return finish();
    }

    throw new Unsupported(`op ${op}`);
  }

  // base/len/filled locals for the array behind an SSA value; never killed
  // (array identity, base, and length are immutable for the whole run)
  arrayCacheFor(arrValue) {
    let entry = this.arrayCaches.get(arrValue.id);
    if (!entry) {
      const base = this.nextLocal++;
      this.declared.push(T.i32);
      const len = this.nextLocal++;
      this.declared.push(T.i32);
      const filled = this.nextLocal++;
      this.declared.push(T.i32);
      entry = { base, len, filled };
      this.arrayCaches.set(arrValue.id, entry);
    }
    return entry;
  }

  heapImports() {
    if (this.abaseIdx === undefined) {
      this.abaseIdx = this.addImport('abase', [T.ref], [T.i32], (a) => (
        a && a.wasmBase !== undefined ? a.wasmBase : -1));
      this.alen0Idx = this.addImport('alen0', [T.ref], [T.i32], (a) => (
        a === null || a === undefined ? 0 : a.length));
      this.aioobIdx = this.addImport('err_aioob', [T.i32, T.i32], [], (i, len) => {
        throw {
          type: 'java/lang/ArrayIndexOutOfBoundsException',
          message: `Index ${i} out of bounds for length ${len}`,
        };
      });
    }
  }

  // Element access through the linear heap: fill the array's base/len cache
  // on first touch, then `base >= 0` selects raw memory access (unsigned
  // bounds check covers negative and past-end in one compare) over the
  // aget/aset import fallback for null or non-heap arrays.
  heapAccessSeq(node, acc, storeSeq, importT) {
    this.heapImports();
    this.usedHeap = true;
    const c = this.arrayCacheFor(node.args[0]);
    const arr = this.useOf(node.args[0]);
    const idx = this.useOf(node.args[1]);
    const addr = [
      OP.local_get, ...uleb(c.base),
      ...idx, ...(acc.shift ? [OP.i32_const, ...sleb(acc.shift), OP.i32_shl] : []),
      OP.i32_add,
    ];
    const bounds = [
      ...idx, OP.local_get, ...uleb(c.len), OP.i32_ge_u, OP.if, 0x40,
      ...idx, OP.local_get, ...uleb(c.len), OP.call, ...uleb(this.aioobIdx), OP.end,
    ];
    const importCall = storeSeq
      ? [...arr, ...idx, ...storeSeq, OP.call,
        ...uleb(this.importIndexByName.get(`aset_${sig(importT)}`))]
      : [...arr, ...idx, OP.call,
        ...uleb(this.importIndexByName.get(`aget_${sig(importT)}`))];
    const heapOp = [OP[acc.op], ...uleb(acc.shift), ...uleb(0)];
    return [
      // fill once per run: base (-1 for null/non-heap) and length
      OP.local_get, ...uleb(c.filled), OP.i32_eqz, OP.if, 0x40,
      ...arr, OP.call, ...uleb(this.abaseIdx), OP.local_set, ...uleb(c.base),
      ...arr, OP.call, ...uleb(this.alen0Idx), OP.local_set, ...uleb(c.len),
      OP.i32_const, ...sleb(1), OP.local_set, ...uleb(c.filled), OP.end,
      OP.local_get, ...uleb(c.base), OP.i32_const, ...sleb(0), OP.i32_ge_s,
      OP.if, storeSeq ? 0x40 : acc.t,
      ...bounds, ...addr, ...(storeSeq || []), ...heapOp,
      OP.else, ...importCall, OP.end,
    ];
  }

  fieldCacheFor(cacheKey, t, killKey, kind, recvId) {
    let entry = this.fieldCaches.get(cacheKey);
    if (!entry) {
      const valLocal = this.nextLocal++;
      this.declared.push(t);
      const filledLocal = this.nextLocal++;
      this.declared.push(T.i32);
      entry = { valLocal, filledLocal, t, killKey, kind, recvId };
      this.fieldCaches.set(cacheKey, entry);
    }
    return entry;
  }

  // Clears every cache keyed on this SSA value: emitted right after the
  // value's wasm local is (re)written, so a cache filled from a previous
  // execution of the defining node (loop-carried receiver) never survives it.
  cacheKillsFor(id) {
    const seq = [];
    const arr = this.arrayCaches.get(id);
    if (arr) seq.push(OP.i32_const, ...sleb(0), OP.local_set, ...uleb(arr.filled));
    for (const e of this.fieldCaches.values()) {
      if (e.recvId === id) {
        seq.push(OP.i32_const, ...sleb(0), OP.local_set, ...uleb(e.filledLocal));
      }
    }
    return seq;
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

  // read through the cache entry; on miss run `loadSeq` (which must leave
  // exactly the loaded value on the wasm stack) and fill the cache. `onMiss`
  // bytes run only when the cache refills — a hit proves the produced value
  // is identical to the cached one, so caches keyed on it stay valid.
  cachedReadSeq(entry, loadSeq, onMiss = []) {
    return [
      OP.local_get, ...uleb(entry.filledLocal), OP.if, entry.t,
      OP.local_get, ...uleb(entry.valLocal),
      OP.else, ...loadSeq,
      OP.local_set, ...uleb(entry.valLocal),
      OP.i32_const, ...sleb(1), OP.local_set, ...uleb(entry.filledLocal),
      ...onMiss,
      OP.local_get, ...uleb(entry.valLocal), OP.end,
    ];
  }

  // Memoized subtype-verdict imports. Never deopts: a hierarchy verdict for a
  // loaded (source, target) pair is immutable, a failed checkcast throws the
  // guest CCE (which unwinds past this frame exactly like the interpreter's),
  // and a live object's class chain is always loaded.
  castImport(op, target) {
    if (typeof target !== 'string') throw new Unsupported(`${op} target`);
    const known = target === 'java/lang/Object' || target.startsWith('[') ||
      this.jvm.classes[target] || this.jvm.jre[target];
    if (!known) throw new Unsupported(`${op} ${target} unloaded`);
    const name = `${op === 'checkcast' ? 'cast' : 'isof'}_${target}`.replace(/[^\w]/g, '_');
    const existing = this.importIndexByName.get(name);
    if (existing !== undefined) return existing;
    const jvm = this.jvm;
    const verdicts = new Map();
    const verdictOf = (ref) => {
      const source = runtimeClassName(ref);
      let ok = verdicts.get(source);
      if (ok === undefined) {
        ok = jvm.isInstanceOf(source, target);
        if (verdicts.size < 64) verdicts.set(source, ok);
      }
      return ok;
    };
    if (op === 'checkcast') {
      return this.addImport(name, [T.ref], [T.ref], (ref) => {
        if (ref === null || ref === undefined) return null;
        if (verdictOf(ref)) return ref;
        throw {
          type: 'java/lang/ClassCastException',
          message: `${runtimeClassName(ref)} cannot be cast to ${target}`,
        };
      });
    }
    return this.addImport(name, [T.ref], [T.i32], (ref) => (
      ref === null || ref === undefined ? 0 : (verdictOf(ref) ? 1 : 0)
    ));
  }

  // invokestatic bound directly to another compiled wasm method — the
  // fully-compiled-only subset of the dispatcher's compiledCallee: no scratch
  // frames, no NestedDeopt, because a fully-compiled callee cannot exit.
  staticCallImport(node) {
    const [, className, [name, descriptor]] = node.imm;
    if (className === 'java/lang/Math') return addMathImport(this, { arg: node.imm });
    if (className === 'java/lang/System') return addTimeImport(this, this.jvm, { arg: node.imm });
    const writes = this.wasmJit
      ? this.wasmJit.staticWriteSummary(className, name, descriptor)
      : null;
    const { params, ret } = parseMethodDescriptor(descriptor);
    if (![...params, ret].every((c) => 'IJFDZBCSV[L'.includes(c))) {
      throw new Unsupported(`invoke ${className}.${name} unsupported descriptor`);
    }
    const calleeSt = this.wasmJit &&
      this.wasmJit.findReadyStatic(className, name, descriptor, false);
    const linked = calleeSt && (calleeSt.callee || calleeSt);
    if (!linked || !linked.meta.fullyCompiled || linked.meta.boxedCount ||
        linked.meta.deoptableCalls) {
      throw new Unsupported(`invoke ${className}.${name}`);
    }
    // Structured callers keep locals in wasm and cannot materialize a frame,
    // so the callee must never deopt. A later recompile may repoint the
    // state to a module with instance-dispatch sites (which can miss); pin
    // the link-time pair as the safe fallback.
    const pinned = { run: linked.run, meta: linked.meta };
    // java arg slot -> position in the wasm arg list
    const argPosBySlot = new Map();
    let slot = 0;
    params.forEach((p, i) => { argPosBySlot.set(slot, i); slot += (p === 'J' || p === 'D') ? 2 : 1; });
    const wParams = params.map(descToWasm);
    const results = ret === 'V' ? [] : [descToWasm(ret)];
    const key = `${className}.${name}${descriptor}`;
    const junk = { locals: [] }; // spill sink; a fully-compiled callee never exits
    const fn = (...args) => {
      const current = calleeSt.callee || calleeSt; // recompiles may repoint it
      const mod = (current.meta.fullyCompiled && !current.meta.boxedCount &&
        !current.meta.deoptableCalls) ? current : pinned;
      const meta = mod.meta;
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
      meta.box.frame = junk;
      meta.box.ret = undefined;
      let status;
      try {
        status = mod.run(...full);
      } finally {
        meta.box.frame = savedFrame;
      }
      if (status !== -1) throw new Error(`wasmjit: nested callee ${key} exited at ${status}`);
      return meta.box.ret;
    };
    return {
      idx: this.addImport(`call_${key}`.replace(/[^\w]/g, '_'), wParams, results, fn),
      writes,
    };
  }

  constSeq(op, node) {
    const arg = node.imm;
    if (op === 'ldc2_w') {
      if (typeof arg === 'bigint') return [OP.i64_const, ...sleb(arg)];
      if (typeof arg === 'number') return [OP.f64_const, ...f64bytes(arg)];
      if (arg && typeof arg === 'object') {
        if (arg.type === 'Long') return [OP.i64_const, ...sleb(BigInt(arg.value))];
        if (arg.type === 'Double') return [OP.f64_const, ...f64bytes(Number(arg.value))];
      }
      throw new Unsupported(`ldc2_w ${JSON.stringify(arg)}`);
    }
    if (typeof arg === 'number') return [OP.i32_const, ...sleb(arg)];
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      if (arg.type === 'Integer') return [OP.i32_const, ...sleb(arg.value)];
      if (arg.type === 'Float') return [OP.f32_const, ...f32bytes(arg.value)];
    }
    throw new Unsupported(`ldc ${JSON.stringify(arg)}`);
  }
}

function headerOfLabel(label) {
  return Number(label.slice(1));
}

// Every block the structurer tree will ask this backend to emit.
function collectTreeBlocks(node, set = new Set()) {
  if (!node) return set;
  switch (node.t) {
    case 'seq': node.body.forEach((child) => collectTreeBlocks(child, set)); break;
    case 'straight': set.add(node.block); break;
    case 'block':
    case 'loop': collectTreeBlocks(node.body, set); break;
    case 'if':
      set.add(node.block);
      collectTreeBlocks(node.then, set);
      collectTreeBlocks(node.els, set);
      break;
    case 'switch':
      set.add(node.block);
      node.cases.forEach((c) => collectTreeBlocks(c.body, set));
      collectTreeBlocks(node.dflt, set);
      break;
    default: break;
  }
  return set;
}

function zeroConst(t) {
  switch (t) {
    case T.i64: return [OP.i64_const, ...sleb(0)];
    case T.f32: return [OP.f32_const, ...f32bytes(0)];
    case T.f64: return [OP.f64_const, ...f64bytes(0)];
    case T.ref: return [OP.ref_null, T.ref];
    default: return [OP.i32_const, ...sleb(0)];
  }
}

module.exports = StructuredWasmCompiler;
