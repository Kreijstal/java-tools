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
// Coverage mirrors the dispatcher's per-block demotion: blocks whose body or
// terminator uses an op this backend cannot emit (monitors, string/class
// constants, virtual invokes, `new` of a not-yet-initialized class), become
// exit stubs — spill the block's reaching slot defs + entry
// stack and return its item index; the interpreter (and the dispatcher OSR
// module) take over. Blocks inside live exception-handler ranges compile with
// wasm try_table/catch_all around every throwing op (status -3 = guest exception
// dispatched at a precise pc); athrow compiles as a throwing import. The
// handler bodies themselves stay interpreter-entered (exception dispatch).
// invokestatic binds directly
// to fully-compiled wasm callees. Whole-method rejection remains only for
// missing/irreducible CFGs, SSA rejection, or a demoted entry block.

const { buildCfgFromCode, structure, IrreducibleError } = require('../decompiler/structurer');
const { buildSsa } = require('../analysis/opgraph/ssa');
const {
  T, OP, TRUNC_SAT, uleb, sleb, f32bytes, f64bytes,
  emitTryTableCatchAll,
  wasmProfilerName, parseMethodDescriptor, descToWasm,
  BRANCH_COND, BRANCH_ZERO, ICONST, BIN_OPS, ARRAY_LOAD, ARRAY_STORE,
  Unsupported, NestedDeopt, isGuestThrow, sig, assembleModule, liveExceptionRanges,
} = require('./wasmShared');
const {
  addRuntimeImports, pushImportFor, addArrayImports, addFieldImport, addMathImport,
  addTimeImport, addNewArrayImport, addANewArrayImport, addNewImport,
} = require('./wasmRuntimeImports');
const { inlineCalls } = require('./wasmInline');
const { runtimeClassName } = require('../instructions/object');
const {
  slabSlotFor, BASE_KEY: SLAB_BASE_KEY,
} = require('../core/objectModel');
const Frame = require('../core/frame');

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
// Guest throwables are plain objects (or guest instances) carrying a string
// `type`; host errors (Unsupported, NestedDeopt, TypeError...) are Error
// instances or lack the tag. The EH catch path must never swallow the latter.
// Placeholder return value while the deopt flag is set; the wasm-side flag
// check exits before the value is observed.
function dummyRet(ret) {
  if (ret === 'V') return undefined;
  if (ret === 'J') return 0n;
  if (ret === 'L' || ret === '[') return null;
  return 0;
}

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
    this.box = {
      frame: null, ret: undefined,
      // EH protocol: the wrapper below records what an import threw so the
      // catch_all arm (which cannot inspect the exception) can tell guest
      // exceptions from host errors, spill, and return -3 — or rethrow.
      pendingException: null, lastThrown: null, throwPc: -1,
      // Call-site deopt protocol: a linked-call import that cannot complete
      // sets deoptFlag (1 = nothing ran, re-execute the invoke interpreted;
      // 2 = the callee exited mid-method, resume after the invoke with
      // pendingFrames materialized above the caller) and returns a dummy;
      // the wasm code checks the flag right after every deoptable call.
      deoptFlag: 0, pendingFrames: null,
    };
  }

  addImport(name, params, results, fn) {
    if (this.importIndexByName.has(name)) return this.importIndexByName.get(name);
    const idx = this.importDecls.length;
    let wrapped = fn;
    if (process.env.JVM_WASM_IMPORT_STATS === '1') {
      if (!this.importStats) this.importStats = new Map();
      const stats = this.importStats;
      const inner = wrapped;
      stats.set(name, 0);
      wrapped = (...args) => {
        stats.set(name, stats.get(name) + 1);
        return inner(...args);
      };
    }
    if (this.ehMethod) {
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
    let elidedThisGuards = 0;
    if (inline) {
      const instanceInline = process.env.JVM_WASM_INSTANCE_INLINE !== '0';
      const expanded = inlineCalls(this.jvm, codeAttr, {
        hierarchy: instanceInline && this.wasmJit ? this.wasmJit.hierarchy : null,
        callerClassName: this.className,
        callerIsStatic: (this.method.flags || []).includes('static'),
      });
      if (expanded) {
        items = expanded.items;
        this.origIdx = expanded.origIdx;
        this.deoptStubs = expanded.deoptStubs;
        this.didInline = true;
        inlinedCalls = expanded.inlined;
        speculations = expanded.speculations;
        specSites = expanded.specSites;
        elidedThisGuards = expanded.elidedThisGuards;
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
    this.originalItems = codeAttr.code.codeItems;

    // Live handler ranges. With EH enabled (default), blocks they cover
    // compile anyway: every throwing op inside such a method is wrapped in
    // wasm try_table/catch_all — a guest exception spills the locals reaching that
    // op, records the throw pc, and returns status -3 so the interpreter's
    // handleException dispatches precisely. Without EH (JVM_WASM_EH=0) the
    // covered blocks demote as before. labelIndex is in EXPANDED item space;
    // hand liveExceptionRanges a code view whose codeItems match, or handlers
    // after a splice point read the wrong items and misclassify as live.
    this.labelIndex = new Map();
    items.forEach((it, i) => {
      if (it.labelDef) this.labelIndex.set(it.labelDef.slice(0, -1), i);
    });
    this.liveRanges = liveExceptionRanges(
      this.jvm, { ...codeAttr.code, codeItems: items }, this.labelIndex,
    );
    this.ehMethod = process.env.JVM_WASM_EH !== '0' && this.liveRanges.length > 0;
    this.usedEh = false;
    // Invoke sites that can hand the call back to the interpreter (partial
    // or late-bound callees). Keyed by item index: the demotion dry-run
    // emits each block twice, so a plain counter would double-count.
    this.deoptableSites = new Set();

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
    addArrayImports(
      this,
      this.method.name,
      this.wasmJit.typedArrayStoresEnabled,
    );

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

    // instanceof verdict caches (SSA-keyed like the above): a verdict is an
    // immutable property of the object's identity — later class loads cannot
    // change what an existing object is an instance of — so entries are
    // killed only when the receiver's SSA value is redefined.
    this.castCaches = new Map();

    // Slab-base caches: per receiver SSA value, the byte base of that object's
    // primitive field block (-1 = not slab-backed) and a filled flag. Like the
    // array base, an object's slab base is immutable for its whole lifetime,
    // so these are killed only when the SSA value is redefined.
    this.slabFields = (this.jvm.wasmFields && this.jvm.wasmHeap) || null;
    this.objCaches = new Map();
    this.slabFieldSites = 0;

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

    // Per-block demotion: live handler ranges first (only when EH is off),
    // then a dry-run of every tree block's body + terminator — any
    // Unsupported demotes just that block to an exit stub instead of
    // rejecting the method.
    const treeBlocks = collectTreeBlocks(structured.tree);
    this.demoted = new Map();
    if (this.liveRanges.length && !this.ehMethod) {
      for (const id of treeBlocks) {
        const insns = cfg.blocks[id].insns;
        const s = insns[0];
        const e = insns[insns.length - 1];
        if (this.liveRanges.some(([rs, re]) => s < re && e >= rs)) {
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
      retvType: parseMethodDescriptor(this.method.descriptor).ret === 'V'
        ? null : descToWasm(parseMethodDescriptor(this.method.descriptor).ret),
      runvWrapper: true,
      specokGlobal: !!this.usesSpecok,
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
      // Modules with EH catch sites return -3 (exception pending) and must
      // never be linked as nested/partial callees: their spill imports write
      // the top frame, and a partial-link resume would re-execute the
      // throwing op (double side effects for invokes).
      usedEh: this.usedEh,
      // Sites that may exit mid-method through the deopt-flag protocol:
      // callers must nest this module with a real scratch frame, never the
      // junk sink (same contract as the dispatcher tier's deoptable calls).
      deoptableCalls: this.deoptableSites.size,
      directLinks: this.directLinks || 0,
      // Normal-flow coverage gap for compile()'s tier preference:
      // instruction-bearing items in DEMOTED tree blocks (counted like the
      // dispatcher's uncoveredItems). Inline guard-miss deopt stubs are
      // rare-path exits by design, not gaps.
      uncoveredItems: [...this.demoted.keys()].filter((id) => treeBlocks.has(id))
        .reduce((sum, id) => sum +
          cfg.blocks[id].insns.filter((i) => items[i] && items[i].instruction).length, 0),
      boxedCount: 0,
      fieldCacheCount: this.fieldCaches.size,
      // getfield/putfield sites compiled to a raw slab load/store instead of
      // a gf_/pf_ import (JVM_WASM_FIELDS); they need no value cache.
      slabFieldSites: this.slabFieldSites,
      structured: true,
      inlinedCalls,
      elidedThisGuards,
      // CHA instanceof guards bake the compile-time world; the jit re-checks
      // specEpoch before every entry, revalidates the sites when the world
      // grew, and recompiles only when a speculated cone actually changed.
      speculations,
      specSites: [...(specSites || []), ...(this.linkSpecSites || [])],
      specEpoch: this.jvm.classEpoch || 0,
      deoptStubCount: this.deoptBlocks.size,
      arrayCacheCount: this.arrayCaches.size,
      importStats: this.importStats || null,
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
    for (const { phi, arg, t } of copies) {
      // An unkinded arg is a conflicted slot join that was never loaded on
      // this path: verified bytecode cannot observe a slot whose types
      // conflict at the join, so the value riding this edge is dead garbage
      // and a zero constant is equivalent (same rule as slotDefsIn spills).
      if (arg.op === 'undef' || KIND_T[arg.kind] === undefined) out.push(...zeroConst(t));
      else if (KIND_T[arg.kind] !== t) {
        // A kinded arg of a different kind than the phi would emit a
        // local.get/local.set wasm type mismatch (invalid module). Stack
        // phis have no kind cross-check in buildSsa, so this is the last
        // line of defense; reject with enough detail to chase the source.
        throw new Unsupported(`phi arg kind mismatch: phi ${phi.kind} ` +
          `${phi.origin && phi.origin.slot !== undefined ? `slot ${phi.origin.slot}` : `stack ${phi.origin ? phi.origin.stackDepth : '?'}`} ` +
          `block ${phi.block} <- arg ${arg.op} kind ${arg.kind}`);
      } else out.push(OP.local_get, ...uleb(this.mustLocal(arg)));
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
    if (op === 'athrow') {
      // Throw the ref JS-side; it unwinds through the wasm frames. In a
      // method with live ranges the site is EH-wrapped for a precise pc; in
      // one without, every table entry is a no-op handler and the stale-pc
      // unwind through executeTick's catch is the status quo for NPE/AIOOBE
      // thrown from compiled blocks.
      const value = term.args[0];
      if (!value || KIND_T[value.kind] !== T.ref) throw new Unsupported('athrow arg kind');
      const idx = this.addImport('athrow', [T.ref], [], (ref) => {
        if (ref === null || ref === undefined) {
          throw { type: 'java/lang/NullPointerException', message: null };
        }
        throw ref;
      });
      if (this.ehMethod) {
        const site = this.ehSiteFor(term.itemIdx);
        emitTryTableCatchAll(
          out,
          body => body.push(...this.useOf(value), OP.call, ...uleb(idx)),
          handler => this.emitEhCatch(term.slotState, site, handler),
        );
      } else {
        out.push(...this.useOf(value), OP.call, ...uleb(idx));
      }
      out.push(OP.unreachable);
      return;
    }
    if (op && op !== 'return') {
      const value = term.args[0];
      const t = KIND_T[value.kind];
      if (t === undefined) throw new Unsupported('return kind');
      // Value leaves twice: through the exported retv global (index 0) for
      // direct wasm->wasm callers, and through the ret_* import for JS
      // entries (an import call is cheaper than a JS-side Global.value read).
      out.push(...this.useOf(value), OP.global_set, ...uleb(0));
      out.push(OP.global_get, ...uleb(0), OP.call,
        ...uleb(this.importIndexByName.get(`ret_${sig(t)}`)));
    }
    out.push(OP.i32_const, ...sleb(-1), OP.return);
  }

  emitBlockBody(blockId, out) {
    const block = this.blockOf(blockId);
    for (const node of block.body) {
      if (this.ehMethod && node.effects && node.effects.mayThrow) {
        this.emitEhWrapped(node, out);
      } else {
        this.emitNode(node, out);
      }
    }
  }

  // In a method with live handler ranges every throwing op — covered or not —
  // must dispatch exceptions with a precise pc: an unwrapped throw would reach
  // handleException with a stale frame.pc that can falsely match a live range.
  // try_table/catch_all is free when nothing throws; on a guest exception the
  // handler spills the locals reaching this op (its wasm locals are all still
  // live), records the throw pc, and returns -3. Host errors rethrow.
  emitEhWrapped(node, out) {
    const site = this.ehSiteFor(node.itemIdx);
    emitTryTableCatchAll(
      out,
      body => this.emitNode(node, body),
      handler => this.emitEhCatch(node.slotState, site, handler),
    );
  }

  ehSiteFor(itemIdx) {
    const orig = this.origIdx ? this.origIdx[itemIdx] : itemIdx;
    if (orig === undefined || orig < 0) throw new Unsupported('eh site inside inlined code');
    const item = this.originalItems[orig];
    const label = item && item.labelDef;
    if (!label) throw new Unsupported('eh site without label');
    return { resumeIdx: orig, pc: parseInt(label.slice(1, -1), 10) };
  }

  emitEhCatch(slotState, site, out) {
    this.usedEh = true;
    const box = this.box;
    out.push(OP.call, ...uleb(this.addImport('eh_pending', [], [T.i32],
      () => (box.pendingException !== null ? 1 : 0))));
    out.push(OP.if, 0x40);
    const spills = [];
    for (const [slot, value] of slotState || []) {
      const t = KIND_T[value.kind];
      if (t === undefined || value.op === 'undef') continue; // dead or conflicted
      spills.push({ slot, value, t });
    }
    const slots = spills.map((s) => s.slot);
    const { resumeIdx, pc } = site;
    const idx = this.addImport(
      `eh_spill_${resumeIdx}`, spills.map((s) => s.t), [],
      (...values) => {
        const frame = box.frame;
        for (let i = 0; i < slots.length; i += 1) frame.locals[slots[i]] = values[i];
        frame.pc = resumeIdx;
        box.throwPc = pc;
      },
    );
    for (const { value } of spills) out.push(...this.useOf(value));
    out.push(OP.call, ...uleb(idx));
    out.push(OP.i32_const, ...sleb(-3), OP.return);
    out.push(OP.end);
    out.push(OP.call, ...uleb(this.addImport('eh_rethrow', [], [],
      () => { throw box.lastThrown; })));
    out.push(OP.unreachable);
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
      const storeImport = this.wasmJit.typedArrayStoresEnabled
        ? `aset_${op}` : `aset_${sig(t)}`;
      out.push(...use(0), ...use(1), ...use(2), OP.call,
        ...uleb(this.importIndexByName.get(storeImport)));
      return finish();
    }
    if (op === 'arraylength') {
      const alenIdx = this.importIndexByName.get('alen');
      if (this.heap) {
        // serve the length from the array's base/len cache (filled once per
        // run); null or non-heap arrays fall back to the import, which
        // keeps the guest NPE
        this.heapImports();
        this.usedHeap = true;
        const c = this.arrayCacheFor(node.args[0]);
        const arr = this.useOf(node.args[0]);
        out.push(
          OP.local_get, ...uleb(c.filled), OP.i32_eqz, OP.if, 0x40,
          ...arr, OP.call, ...uleb(this.abaseIdx), OP.local_set, ...uleb(c.base),
          ...arr, OP.call, ...uleb(this.alen0Idx), OP.local_set, ...uleb(c.len),
          OP.i32_const, ...sleb(1), OP.local_set, ...uleb(c.filled), OP.end,
          OP.local_get, ...uleb(c.base), OP.i32_const, ...sleb(0), OP.i32_ge_s,
          OP.if, T.i32,
          OP.local_get, ...uleb(c.len),
          OP.else, ...arr, OP.call, ...uleb(alenIdx), OP.end);
        return finish();
      }
      out.push(...use(0), OP.call, ...uleb(alenIdx));
      return finish();
    }

    // fields
    if (op === 'getstatic' || op === 'getfield' || op === 'putstatic' || op === 'putfield') {
      const isGet = op[0] === 'g';
      const isStatic = op.endsWith('static');
      const field = addFieldImport(this, this.jvm, { arg: node.imm }, isStatic, isGet);
      const [, fieldOwner, [fieldName, descriptor]] = node.imm;
      const killKey = `${fieldName}:${descriptor}`;
      const caching = !this.wasmJit || this.wasmJit.fieldCacheEnabled !== false;
      // Slab path: the field has a static offset inside the wasm memory and
      // its slot kind matches the wasm type the import would have produced
      // (float fields keep an f64 slot for JS, so they stay on the import).
      const slot = !isStatic && this.slabFields
        ? slabSlotFor(this.jvm, fieldOwner, fieldName) : null;
      const slotT = slot && (slot.kind === 'i32' ? T.i32
        : slot.kind === 'f64' ? T.f64 : T.i64);
      if (slot && slotT === field.t) {
        this.slabFieldSites += 1;
        out.push(...this.slabAccessSeq(node, slot, field.idx, isGet, use));
        if (isGet) {
          out.push(OP.local_set, ...uleb(this.mustLocal(node)));
          out.push(...this.cacheKillsFor(node.id));
        } else {
          // A raw store bypasses the pf_ import that other receivers' value
          // caches were implicitly invalidated by, so kill them explicitly.
          out.push(...this.killSeqWhere((entry) => (
            entry.kind === 'f' && entry.killKey === killKey)));
        }
        return;
      }
      if (isGet && caching) {
        const cacheKey = isStatic
          ? `s|${field.name}` : `f|${node.args[0].id}|${field.name}`;
        const entry = this.fieldCacheFor(cacheKey, field.t, killKey, isStatic ? 's' : 'f',
          isStatic ? null : node.args[0].id);
        entry.readerIds.add(node.id);
        // cached instance path skips the null check: a filled flag proves
        // this exact SSA value already loaded this field successfully
        const loadSeq = isStatic
          ? [OP.call, ...uleb(field.idx)]
          : [...use(0), OP.call, ...uleb(field.idx)];
        // Dependent caches (arrays/fields keyed on a reader's value) are
        // killed on the refill path only — a hit reproduces the entry's
        // cached value verbatim. The entry is SHARED by every reader node of
        // this field, so a refill must kill the dependents of ALL readers:
        // a sibling's later hit hands it the refilled (possibly different)
        // object while its dependents still describe the previous one
        // (in-loop `b = grow(b)` reassignment was read through a stale
        // array base/len exactly this way).
        const onMiss = [];
        for (const id of entry.readerIds) onMiss.push(...this.cacheKillsFor(id));
        out.push(...this.cachedReadSeq(entry, loadSeq, onMiss));
        if (node.kind !== 'V') out.push(OP.local_set, ...uleb(this.mustLocal(node)));
        return;
      }
      for (let i = 0; i < node.args.length; i += 1) out.push(...use(i));
      out.push(OP.call, ...uleb(field.idx));
      if (!isGet) {
        out.push(...this.killSeqWhere((entry) => (
          entry.kind === (isStatic ? 's' : 'f') && entry.killKey === killKey)));
        // Write-through: after the aliasing kills, this receiver's own cache
        // holds the just-stored value, so the next read hits instead of
        // refilling through the import. The entry must be the one the READ
        // path keys on (the get-import name), not this put-import's name.
        // Non-ref fields only — a primitive reader value can never key
        // dependent array/field caches, so a hit that skips the refill
        // path's dependent kills stays sound.
        if (caching && field.t !== T.ref) {
          const readField = addFieldImport(this, this.jvm, { arg: node.imm }, isStatic, true);
          const cacheKey = isStatic
            ? `s|${readField.name}` : `f|${node.args[0].id}|${readField.name}`;
          const entry = this.fieldCacheFor(cacheKey, readField.t, killKey,
            isStatic ? 's' : 'f', isStatic ? null : node.args[0].id);
          out.push(...use(isStatic ? 0 : 1), OP.local_set, ...uleb(entry.valLocal));
          out.push(OP.i32_const, ...sleb(1), OP.local_set, ...uleb(entry.filledLocal));
        }
      }
      return finish();
    }

    // calls: Math/System intrinsics, direct binding to compiled wasm
    // callees, and devirtualized instance calls through a closed-world
    // dispatch map. Sites whose callee can hand the call back (deoptable)
    // get a flag check + exit stub right after the import call.
    if (op === 'invokestatic' || op === 'invokevirtual' ||
        op === 'invokespecial' || op === 'invokeinterface') {
      if (op === 'invokespecial') {
        const [, sOwner, [sName, sDesc]] = node.imm;
        if (sName === '<init>' && sDesc === '()V' && sOwner === 'java/lang/Object') {
          // java/lang/Object.<init> is empty (a no-op JRE stub here); the
          // receiver of a super()/new Object() call is never null
          return;
        }
      }
      const call = op === 'invokestatic'
        ? this.staticCallImport(node)
        : this.instanceCallImport(node, op);
      let site = null;
      let unders = null;
      if (call.deoptable) {
        site = this.ehSiteFor(node.itemIdx); // Unsupported inside inlined code
        unders = node.stackUnder || [];
        for (const v of unders) {
          if (KIND_T[v.kind] === undefined) throw new Unsupported('unkinded call under');
        }
        this.deoptableSites.add(node.itemIdx);
      }
      for (let i = 0; i < node.args.length; i += 1) out.push(...use(i));
      if (call.directLink) {
        // Guarded direct instance call: matching receivers take the runv
        // fast path (never-exits invariant verified in wasm), everything
        // else replays the stashed operands into the generic dispatch
        // import, whose deopt check stays on that branch only. Kills run
        // after the merge; the deopt exit abandons this invocation's
        // locals, so skipping them there is unobservable.
        const dl = call.directLink;
        const argScr = dl.argTypes.map((t) => {
          const local = this.nextLocal++;
          this.declared.push(t);
          return local;
        });
        for (let i = argScr.length - 1; i >= 0; i--) {
          out.push(OP.local_set, ...uleb(argScr[i]));
        }
        if (dl.guardIdx !== undefined) {
          out.push(OP.local_get, ...uleb(argScr[0]), OP.call, ...uleb(dl.guardIdx));
        } else {
          // invokespecial is statically bound: the only guard is non-null.
          // Speculative monomorphic links add the in-wasm specok flag
          // (zeroed on class load, re-armed by entry revalidation).
          out.push(OP.local_get, ...uleb(argScr[0]), OP.ref_is_null, OP.i32_eqz);
          if (dl.specMono) {
            out.push(OP.global_get, ...uleb(dl.specokIdx), OP.i32_and);
          }
        }
        out.push(OP.if, 0x40);
        for (const local of argScr) out.push(OP.local_get, ...uleb(local));
        out.push(OP.call, ...uleb(dl.directIdx));
        if (node.kind !== 'V') out.push(OP.local_set, ...uleb(this.mustLocal(node)));
        out.push(OP.i32_const, ...sleb(-1), OP.i32_ne,
          OP.if, 0x40, OP.unreachable, OP.end);
        out.push(OP.else);
        for (const local of argScr) out.push(OP.local_get, ...uleb(local));
        out.push(OP.call, ...uleb(call.idx));
        if (node.kind !== 'V') out.push(OP.local_set, ...uleb(this.mustLocal(node)));
        this.emitCallDeoptCheck(node, site, unders, out);
        out.push(OP.end);
        if (call.writes === null) out.push(...this.killSeqWhere(() => true));
        else if (call.writes && call.writes.size) {
          out.push(...this.killSeqWhere((entry) => call.writes.has(entry.killKey)));
        }
        if (node.kind !== 'V') out.push(...this.cacheKillsFor(node.id));
        return;
      }
      out.push(OP.call, ...uleb(call.idx));
      if (call.direct) {
        // runv returned [status, value]: bank the value, verify the
        // never-exits invariant in wasm.
        if (node.kind !== 'V') out.push(OP.local_set, ...uleb(this.mustLocal(node)));
        out.push(OP.i32_const, ...sleb(-1), OP.i32_ne,
          OP.if, 0x40, OP.unreachable, OP.end);
      }
      // kill only the caches the callee may transitively write (math/time
      // intrinsics carry no summary and write nothing); an unknowable
      // callee (null summary) may put any field or static
      if (call.writes === null) out.push(...this.killSeqWhere(() => true));
      else if (call.writes && call.writes.size) {
        out.push(...this.killSeqWhere((entry) => call.writes.has(entry.killKey)));
      }
      if (node.kind !== 'V') {
        if (!call.direct) out.push(OP.local_set, ...uleb(this.mustLocal(node)));
        out.push(...this.cacheKillsFor(node.id));
      }
      if (call.deoptable) this.emitCallDeoptCheck(node, site, unders, out);
      return;
    }

    // allocation: pure JS-side imports, no guest code (see wasmRuntimeImports);
    // `new` demotes unless the class is already initialized at compile time
    if (op === 'newarray') {
      out.push(...use(0), OP.call, ...uleb(addNewArrayImport(this, this.jvm, node.imm)));
      return finish();
    }
    if (op === 'anewarray') {
      out.push(...use(0), OP.call, ...uleb(addANewArrayImport(this, this.jvm, node.imm)));
      return finish();
    }
    if (op === 'new') {
      out.push(OP.call, ...uleb(addNewImport(this, this.jvm, node.imm)));
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
      if (op === 'instanceof' && (!this.wasmJit || this.wasmJit.fieldCacheEnabled !== false)) {
        // guard-shaped instanceof runs per loop iteration on a loop-invariant
        // receiver: cache the verdict per SSA value instead of crossing into
        // JS every time
        const importIdx = this.castImport(op, node.imm);
        const c = this.castCacheFor(node.args[0], node.imm);
        out.push(
          OP.local_get, ...uleb(c.filled), OP.i32_eqz, OP.if, 0x40,
          ...use(0), OP.call, ...uleb(importIdx), OP.local_set, ...uleb(c.verdict),
          OP.i32_const, ...sleb(1), OP.local_set, ...uleb(c.filled), OP.end,
          OP.local_get, ...uleb(c.verdict));
        return finish();
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
    const storeImport = this.wasmJit.typedArrayStoresEnabled
      ? `aset_${node.op}` : `aset_${sig(importT)}`;
    const importCall = storeSeq
      ? [...arr, ...idx, ...storeSeq, OP.call,
        ...uleb(this.importIndexByName.get(storeImport))]
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

  // base/filled locals for the slab block behind a receiver SSA value.
  objCacheFor(objValue) {
    let entry = this.objCaches.get(objValue.id);
    if (!entry) {
      const base = this.nextLocal++;
      this.declared.push(T.i32);
      const filled = this.nextLocal++;
      this.declared.push(T.i32);
      entry = { base, filled };
      this.objCaches.set(objValue.id, entry);
    }
    return entry;
  }

  objImports() {
    if (this.obaseIdx === undefined) {
      this.obaseIdx = this.addImport('obase', [T.ref], [T.i32], (o) => {
        if (!o || !o.fields) return -1;
        const base = o.fields[SLAB_BASE_KEY];
        return base === undefined ? -1 : base;
      });
    }
  }

  // getfield/putfield straight into the linear heap: fill the receiver's slab
  // base on first touch, then `base >= 0` selects a raw load/store at the
  // field's static offset over the gf_/pf_ import. A receiver whose class is
  // not slab-backed (JRE stub, hierarchy not yet resolved, heap spent) reports
  // base -1 and takes the import, so the two representations coexist.
  slabAccessSeq(node, slot, fieldIdx, isGet, use) {
    this.objImports();
    this.usedHeap = true;
    const cache = this.objCacheFor(node.args[0]);
    const recv = use(0);
    const align = slot.kind === 'i32' ? 2 : 3;
    const memOp = slot.kind === 'i32'
      ? (isGet ? OP.i32_load : OP.i32_store)
      : slot.kind === 'f64'
        ? (isGet ? OP.f64_load : OP.f64_store)
        : (isGet ? OP.i64_load : OP.i64_store);
    const raw = isGet
      ? [OP.local_get, ...uleb(cache.base),
        memOp, ...uleb(align), ...uleb(slot.offset)]
      : [OP.local_get, ...uleb(cache.base), ...use(1),
        memOp, ...uleb(align), ...uleb(slot.offset)];
    const viaImport = isGet
      ? [...recv, OP.call, ...uleb(fieldIdx)]
      : [...recv, ...use(1), OP.call, ...uleb(fieldIdx)];
    const blockT = isGet
      ? (slot.kind === 'i32' ? T.i32 : slot.kind === 'f64' ? T.f64 : T.i64)
      : 0x40;
    return [
      OP.local_get, ...uleb(cache.filled), OP.i32_eqz, OP.if, 0x40,
      ...recv, OP.call, ...uleb(this.obaseIdx), OP.local_set, ...uleb(cache.base),
      OP.i32_const, ...sleb(1), OP.local_set, ...uleb(cache.filled), OP.end,
      OP.local_get, ...uleb(cache.base), OP.i32_const, ...sleb(0), OP.i32_ge_s,
      OP.if, blockT,
      ...raw,
      OP.else, ...viaImport, OP.end,
    ];
  }

  fieldCacheFor(cacheKey, t, killKey, kind, recvId) {
    let entry = this.fieldCaches.get(cacheKey);
    if (!entry) {
      const valLocal = this.nextLocal++;
      this.declared.push(t);
      const filledLocal = this.nextLocal++;
      this.declared.push(T.i32);
      entry = { valLocal, filledLocal, t, killKey, kind, recvId, readerIds: new Set() };
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
    for (const e of this.castCaches.values()) {
      if (e.recvId === id) {
        seq.push(OP.i32_const, ...sleb(0), OP.local_set, ...uleb(e.filled));
      }
    }
    const obj = this.objCaches.get(id);
    if (obj) seq.push(OP.i32_const, ...sleb(0), OP.local_set, ...uleb(obj.filled));
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
  // verdict/filled locals for `value instanceof target`; killed only when
  // the receiver's SSA value is redefined (cacheKillsFor)
  castCacheFor(value, target) {
    const key = `${value.id}|${target}`;
    let entry = this.castCaches.get(key);
    if (!entry) {
      const verdict = this.nextLocal++;
      this.declared.push(T.i32);
      const filled = this.nextLocal++;
      this.declared.push(T.i32);
      entry = { verdict, filled, recvId: value.id };
      this.castCaches.set(key, entry);
    }
    return entry;
  }

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

  // invokestatic bound directly to another compiled wasm method. A callee
  // that can never exit (fully compiled, no deoptable calls) is called with
  // a junk frame; any other ready callee takes the scratch-frame nested-call
  // protocol (runNested) behind a deoptable site.
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
      this.wasmJit.findReadyStatic(className, name, descriptor, true);
    const linked = calleeSt && (calleeSt.callee || calleeSt);
    if (!linked) throw new Unsupported(`invoke ${className}.${name}`);
    // java arg slot -> position in the wasm arg list
    const argPosBySlot = new Map();
    let slot = 0;
    params.forEach((p, i) => { argPosBySlot.set(slot, i); slot += (p === 'J' || p === 'D') ? 2 : 1; });
    const wParams = params.map(descToWasm);
    const results = ret === 'V' ? [] : [descToWasm(ret)];
    const key = `${className}.${name}${descriptor}`;
    // Direct wasm->wasm link through the callee's runv export: no JS bridge
    // on the path. EH callers keep the bridge (their import wrapper records
    // thrown exceptions for catch_all classification); non-identity slot
    // mappings keep the bridge (the JS closure reorders/pads arguments).
    if (this.wasmJit.directStaticLinkEnabled && !this.ehMethod &&
        linked.meta.fullyCompiled && !linked.meta.boxedCount &&
        !linked.meta.deoptableCalls && !linked.meta.usedEh &&
        linked.meta.runv) {
      const identity = linked.meta.paramSlots.length === params.length &&
        linked.meta.paramSlots.every((p, i) => {
          let at = 0;
          for (let k = 0; k < i; k++) at += (params[k] === 'J' || params[k] === 'D') ? 2 : 1;
          return p.slot === at && p.t === descToWasm(params[i]);
        });
      if (identity) {
        return {
          idx: this.addImport(`dcall_${key}`.replace(/[^\w]/g, '_'), wParams,
            ret === 'V' ? [T.i32] : [T.i32, descToWasm(ret)],
            linked.meta.runv),
          writes,
          direct: true,
        };
      }
    }
    if (linked.meta.fullyCompiled && !linked.meta.boxedCount &&
        !linked.meta.deoptableCalls && !linked.meta.usedEh) {
      // Never-exits fast path: no scratch frame, no flag check. A later
      // recompile may repoint the state to a module with deoptable sites;
      // pin the link-time pair as the safe fallback. usedEh matters here:
      // a dispatcher-tier EH module can be fullyCompiled (its fullyCompiled
      // has no empty-table requirement) yet return -3.
      const pinned = { run: linked.run, meta: linked.meta };
      const junk = { locals: [] }; // spill sink; a fully-compiled callee never exits
      const fn = (...args) => {
        const current = calleeSt.callee || calleeSt; // recompiles may repoint it
        const mod = (current.meta.fullyCompiled && !current.meta.boxedCount &&
          !current.meta.deoptableCalls && !current.meta.usedEh) ? current : pinned;
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
    if (calleeSt.linkVetoed) throw new Unsupported(`partial callee ${key} vetoed`);
    const scratchFrames = new Map();
    const dummy = dummyRet(ret);
    const fn = (...args) => this.runNested(
      calleeSt, className, args, argPosBySlot, scratchFrames, dummy,
    );
    return {
      idx: this.addImport(`pcall_${key}`.replace(/[^\w]/g, '_'), wParams, results, fn),
      writes,
      deoptable: true,
    };
  }

  // invokevirtual/invokeinterface/invokespecial bound through a closed-world
  // dispatch table, mirroring the dispatcher tier's compiledInstanceCallee.
  // The import selects the target module by the receiver's runtime class. A
  // map miss may install an exact later-loaded target when its writes fit the
  // caller's already-emitted cache kills; otherwise deopt flag 1 makes the
  // interpreter re-execute the invoke with full dynamic dispatch. Targets
  // that can exit run under the scratch-frame protocol.
  instanceCallImport(node, op) {
    const [, owner, [name, descriptor]] = node.imm;
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
    const readyOrThrow = (implClassName) => {
      const st = this.wasmJit.findReadyInstance(implClassName, name, descriptor);
      if (!st) throw new Unsupported(`invoke ${owner}.${name} impl ${implClassName} not ready`);
      const m = (st.callee || st).meta;
      if (st.linkVetoed && !m.fullyCompiled) {
        throw new Unsupported(`partial callee ${implClassName}.${name} vetoed`);
      }
      return st;
    };
    let dispatch = null;
    let direct = null;
    let resolvedCone = null;
    if (op === 'invokespecial') {
      const impl = name === '<init>'
        ? hierarchy.resolveInit(owner, descriptor)
        : hierarchy.resolveSpecial(this.className, owner, name, descriptor);
      if (!impl) throw new Unsupported(`invokespecial ${owner}.${name} unresolved`);
      direct = readyOrThrow(impl.className);
      if (name === '<init>') {
        // all-or-nothing: a constructor target must be unable to hand the
        // call back mid-body — it either completes or throws
        const m = (direct.callee || direct).meta;
        if (!m.fullyCompiled || m.deoptableCalls || m.usedEh) {
          throw new Unsupported(`<init> ${owner} target not fully compiled`);
        }
      }
    } else {
      const resolved = hierarchy.resolveDispatch(owner, name, descriptor);
      resolvedCone = resolved;
      if (!resolved) throw new Unsupported(`invoke ${owner}.${name} unresolved`);
      if (resolved.impls.size > 4) throw new Unsupported(`invoke ${owner}.${name} megamorphic`);
      // Impls that cannot be linked (never-compiling entry, EH module,
      // vetoed) just drop out of the map: their receivers miss at runtime
      // and deopt before anything runs, which is always sound. Only a site
      // with no ready impl at all keeps the demotion status quo.
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
      if (!readyCount) throw new Unsupported(`invoke ${owner}.${name} no ready impl`);
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
    const wParams = [T.ref, ...params.map(descToWasm)];
    const results = ret === 'V' ? [] : [descToWasm(ret)];
    const key = `${owner}.${name}${descriptor}`;
    const box = this.box;
    const scratchFrames = new Map();
    const dummy = dummyRet(ret);
    // Union of the targets known when the caller is emitted. Late targets
    // can continue in wasm only when this kill set covers their writes.
    let writes = new Set();
    for (const st of direct ? [direct] : new Set(dispatch.values())) {
      const sub = this.wasmJit.instanceWriteSummary(st.targetClassName, name, descriptor);
      if (sub === null) { writes = null; break; }
      for (const k of sub) writes.add(k);
    }
    const lateMissEpoch = new Map();
    const fn = (...args) => {
      const receiver = args[0];
      if (receiver === null || receiver === undefined) {
        throw { type: 'java/lang/NullPointerException', message: null };
      }
      const receiverClass = runtimeClassName(receiver);
      let calleeSt = direct || dispatch.get(receiverClass);
      if (!calleeSt && dispatch) {
        const epoch = `${this.jvm.classEpoch || 0}:${this.wasmJit.compileEpoch}`;
        if (lateMissEpoch.get(receiverClass) !== epoch) {
          lateMissEpoch.set(receiverClass, epoch);
          calleeSt = this.wasmJit.resolveLateInstanceTarget(
            owner, name, descriptor, receiverClass, writes,
          );
          if (calleeSt) {
            dispatch.set(receiverClass, calleeSt);
            lateMissEpoch.delete(receiverClass);
          }
        }
      }
      if (!calleeSt) {
        box.deoptFlag = 1; // nothing ran: re-execute the invoke interpreted
        return dummy;
      }
      return this.runNested(
        calleeSt, calleeSt.targetClassName, args, argPosBySlot, scratchFrames, dummy,
      );
    };
    // Direct wasm->wasm fast path for the single-ready-target shape,
    // mirroring the dispatcher tier: matching receivers call the target's
    // runv export with no JS on the path (an in-wasm null check suffices for
    // statically-bound invokespecial; virtual sites pay one receiver-class
    // guard import), everything else falls back to the generic dispatch
    // import above, so miss/late-target/deopt soundness is unchanged.
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
        !calleeMeta.boxedCount && !calleeMeta.deoptableCalls &&
        !calleeMeta.usedEh && calleeMeta.runv && !st.linkVetoed &&
        (!speculative ||
          (!direct && this.wasmJit.revalidateNestedCallee(st)));
      let identity = false;
      if (eligible) {
        identity = calleeMeta.paramSlots.length === params.length + 1 &&
          calleeMeta.paramSlots.every((p, i) => {
            if (i === 0) return p.slot === 0 && p.t === T.ref;
            let at = 1;
            for (let k = 0; k < i - 1; k++) {
              at += (params[k] === 'J' || params[k] === 'D') ? 2 : 1;
            }
            return p.slot === at && p.t === descToWasm(params[i - 1]);
          });
      }
      if (identity) {
        const directIdx = this.addImport(
          `dcall_${key}`.replace(/[^\w]/g, '_'), wParams,
          ret === 'V' ? [T.i32] : [T.i32, descToWasm(ret)],
          calleeMeta.runv);
        let guardIdx;
        let specMono = false;
        if (!direct) {
          // A COMPLETE monomorphic cone needs no receiver-class guard:
          // every loaded receiver dispatches to the single impl, the
          // caller records the speculation, and the in-wasm specok flag
          // (zeroed synchronously on class load, re-armed by entry
          // revalidation) closes the mid-run-load hole.
          if (resolvedCone && resolvedCone.complete &&
              resolvedCone.impls.size === 1) {
            specMono = true;
            const implClassName =
              [...resolvedCone.impls.values()][0].className;
            if (!this.linkSpecSites) this.linkSpecSites = [];
            this.linkSpecSites.push({
              owner, name, descriptor, guards: [implClassName],
            });
            this.usesSpecok = true;
          } else {
            const directClasses = new Set();
            for (const [runtimeClass, targetSt] of dispatch) {
              if (targetSt === st) directClasses.add(runtimeClass);
            }
            guardIdx = this.addImport(
              `dguard_${key}`.replace(/[^\w]/g, '_'), [T.ref], [T.i32],
              (r) => (r !== null && r !== undefined &&
                directClasses.has(runtimeClassName(r))) ? 1 : 0);
          }
        }
        directLink = {
          directIdx, guardIdx, specMono,
          specokIdx:
            parseMethodDescriptor(this.method.descriptor).ret === 'V' ? 0 : 1,
          argTypes: wParams,
        };
        this.directLinks = (this.directLinks || 0) + 1;
      }
    }
    // invokespecial binds statically: keep its import distinct from a
    // virtual site sharing the same method key
    const prefix = op === 'invokespecial' ? 'scall' : 'vcall';
    return {
      idx: this.addImport(`${prefix}_${key}`.replace(/[^\w]/g, '_'), wParams, results, fn),
      writes,
      deoptable: true,
      directLink,
    };
  }

  // One nested call into a linked callee module for a deoptable site. On a
  // clean return hands back the callee's value. When the callee cannot be
  // nested (EH module after a recompile) sets deopt flag 1 without running
  // anything; when it exits mid-method (or a deeper link deopts) parks the
  // callee frames on the box innermost-first and sets flag 2. Guest
  // exceptions from the callee propagate to this module's own wrap.
  runNested(calleeSt, frameClassName, javaArgs, argPosBySlot, scratchFrames, dummy) {
    const box = this.box;
    // A captured guard-elided module must re-check its baked class world
    // before running; on invalidation nothing has run yet, so flag 1 makes
    // the interpreter re-execute the invoke with full dynamic dispatch.
    if (!this.wasmJit.revalidateNestedCallee(calleeSt)) {
      box.deoptFlag = 1;
      return dummy;
    }
    const calleeMod = calleeSt.callee || calleeSt;
    const meta = calleeMod.meta;
    // usedEh forces a scratch frame: a -3 exit spills into box.frame and
    // dispatches inside it below.
    const partial = !meta.fullyCompiled || meta.boxedCount > 0 ||
      meta.deoptableCalls > 0 || meta.usedEh;
    const full = new Array(meta.paramSlots.length + 2);
    for (let i = 0; i < meta.paramSlots.length; i += 1) {
      const p = meta.paramSlots[i];
      const pos = argPosBySlot.get(p.slot);
      if (pos !== undefined) full[i] = javaArgs[pos];
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
        frame.className = frameClassName;
        if (!scratch) scratchFrames.set(calleeSt, frame);
      }
      frame.inUse = true;
    } else {
      frame = { locals: [] }; // junk sink; this callee never exits
    }
    meta.box.frame = frame;
    meta.box.ret = undefined;
    let status;
    try {
      status = calleeMod.run(...full);
    } catch (err) {
      if (partial && err instanceof NestedDeopt) {
        err.frames.push(frame);
        if (frame === scratchFrames.get(calleeSt)) scratchFrames.delete(calleeSt);
        box.pendingFrames = err.frames;
        box.deoptFlag = 2;
        return dummy;
      }
      throw err;
    } finally {
      if (partial) frame.inUse = false;
      meta.box.frame = savedFrame;
    }
    if (status === -3) {
      // The callee caught a guest exception in wasm: its spill import
      // already wrote the throw-point locals into `frame` (its scratch).
      // Dispatch inside the callee's own table; a handler match parks the
      // frame positioned at the handler, no match propagates the exception
      // to this module's wrap (EH catch or plain unwind).
      const exn = meta.box.pendingException;
      meta.box.pendingException = null;
      if (this.jvm.dispatchExceptionInFrame(frame, exn, meta.box.throwPc)) {
        if (frame === scratchFrames.get(calleeSt)) scratchFrames.delete(calleeSt);
        box.pendingFrames = [frame];
        box.deoptFlag = 2;
        return dummy;
      }
      throw exn;
    }
    if (status !== -1) {
      if (!partial) throw new Error(`wasmjit: nested callee exited at ${status}`);
      frame.pc = status;
      if (frame === scratchFrames.get(calleeSt)) scratchFrames.delete(calleeSt);
      // the callee's own call-site deopt may have parked deeper frames
      const deeper = meta.box.pendingFrames;
      meta.box.pendingFrames = null;
      box.pendingFrames = deeper ? [...deeper, frame] : [frame];
      box.deoptFlag = 2;
      calleeSt.nestedDeopts = (calleeSt.nestedDeopts || 0) + 1;
      return dummy;
    }
    return meta.box.ret;
  }

  // Wasm-side check right after a deoptable call: read-and-clear the box
  // flag; 1 = re-execute the invoke interpreted (push unders + operands),
  // 2 = the callee exited mid-method (push unders only; the parked callee
  // frames finish first and the interpreter's return push delivers the
  // result), resuming after the invoke.
  emitCallDeoptCheck(node, site, unders, out) {
    const box = this.box;
    const flagIdx = this.addImport('call_deopt_flag', [], [T.i32], () => {
      const f = box.deoptFlag;
      box.deoptFlag = 0;
      return f;
    });
    const tmp = this.nextLocal++;
    this.declared.push(T.i32);
    out.push(OP.call, ...uleb(flagIdx), OP.local_tee, ...uleb(tmp));
    out.push(OP.if, 0x40);
    out.push(OP.local_get, ...uleb(tmp), OP.i32_const, ...sleb(1), OP.i32_eq);
    out.push(OP.if, 0x40);
    this.emitCallExitStub(node, site, unders, true, out);
    out.push(OP.end);
    this.emitCallExitStub(node, site, unders, false, out);
    out.push(OP.end);
  }

  emitCallExitStub(node, site, unders, reexecute, out) {
    // locals as of the call, from the SSA snapshot (same filter as EH spill)
    const spills = [];
    for (const [slot, value] of node.slotState || []) {
      const t = KIND_T[value.kind];
      if (t === undefined || value.op === 'undef') continue; // dead or conflicted
      spills.push({ slot, value, t });
    }
    if (spills.length) {
      const slots = spills.map((s) => s.slot);
      const box = this.box;
      const idx = this.addImport(
        `call_spill_${site.resumeIdx}`, spills.map((s) => s.t), [],
        (...values) => {
          const locals = box.frame.locals;
          for (let i = 0; i < slots.length; i += 1) locals[slots[i]] = values[i];
        },
      );
      for (const { value } of spills) out.push(...this.useOf(value));
      out.push(OP.call, ...uleb(idx));
    }
    // interpreter operand stack, bottom-up: values under the call's args,
    // then — only when the invoke re-executes — the operands themselves
    for (const value of unders) {
      out.push(...this.useOf(value), OP.call, ...uleb(pushImportFor(this, KIND_T[value.kind])));
    }
    if (reexecute) {
      for (const value of node.args) {
        const t = KIND_T[value.kind];
        if (t === undefined) throw new Unsupported('unkinded call operand');
        out.push(...this.useOf(value), OP.call, ...uleb(pushImportFor(this, t)));
      }
    }
    out.push(OP.i32_const, ...sleb(reexecute ? site.resumeIdx : site.resumeIdx + 1), OP.return);
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
