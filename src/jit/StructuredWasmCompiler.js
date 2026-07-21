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
const { inlineStaticCalls } = require('./wasmInline');

const KIND_T = { I: T.i32, J: T.i64, F: T.f32, D: T.f64, A: T.ref };
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
    let inlinedCalls = 0;
    if (inline) {
      const expanded = inlineStaticCalls(this.jvm, codeAttr);
      if (expanded) {
        items = expanded.items;
        this.origIdx = expanded.origIdx;
        this.didInline = true;
        inlinedCalls = expanded.inlined;
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
    const liveRanges = liveExceptionRanges(this.jvm, codeAttr.code, labelIndex);
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
      if (this.demoted.has(id)) continue;
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
      if (treeBlocks.has(block.id) && !this.demoted.has(block.id)) {
        supportedBlocks.add(block.id);
      }
    }
    const env = {};
    this.importDecls.forEach((d, i) => { env[d.name] = this.importFns[i]; });
    const normalFlowFullyCompiled = this.demoted.size === 0;
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
      fieldCacheCount: 0,
      structured: true,
      inlinedCalls,
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
      if (arg.op === 'undef') out.push(...zeroConst(t));
      else out.push(OP.local_get, ...uleb(this.mustLocal(arg)));
    }
    for (let i = copies.length - 1; i >= 0; i -= 1) {
      out.push(OP.local_set, ...uleb(this.mustLocal(copies[i].phi)));
    }
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
  // fuel-exhaustion exits (inside the fuel if) and demoted-block exit stubs.
  emitSpillResume(blockId, out) {
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
      if (node.kind !== 'V') out.push(OP.local_set, ...uleb(this.mustLocal(node)));
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
      out.push(...use(0), ...use(1), OP.call,
        ...uleb(this.importIndexByName.get(`aget_${sig(t)}`)));
      return finish();
    }
    if (ARRAY_STORE[op] !== undefined) {
      const t = ARRAY_STORE[op];
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
      const field = addFieldImport(this, this.jvm, { arg: node.imm }, op.endsWith('static'), isGet);
      for (let i = 0; i < node.args.length; i += 1) out.push(...use(i));
      out.push(OP.call, ...uleb(field.idx));
      return finish();
    }

    // calls: Math intrinsics, or direct binding to a fully-compiled callee
    if (op === 'invokestatic') {
      const call = this.staticCallImport(node);
      for (let i = 0; i < node.args.length; i += 1) out.push(...use(i));
      out.push(OP.call, ...uleb(call.idx));
      return finish();
    }

    throw new Unsupported(`op ${op}`);
  }

  // invokestatic bound directly to another compiled wasm method — the
  // fully-compiled-only subset of the dispatcher's compiledCallee: no scratch
  // frames, no NestedDeopt, because a fully-compiled callee cannot exit.
  staticCallImport(node) {
    const [, className, [name, descriptor]] = node.imm;
    if (className === 'java/lang/Math') return addMathImport(this, { arg: node.imm });
    if (className === 'java/lang/System') return addTimeImport(this, this.jvm, { arg: node.imm });
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
