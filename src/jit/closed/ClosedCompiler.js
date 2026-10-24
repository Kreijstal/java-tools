'use strict';

// Method body compiler for the closed-world module.
//
// Input: one admitted method's SSA (analysis/opgraph/ssa) plus the per-node
// resolution plan ClosedWorld computed during admission. Output: a Wasm
// function body over the closed representation (representation.js).
//
// Control flow uses Ramsey's "Beyond Relooper" translation directly on the
// SSA CFG: a loop header becomes `loop`, a merge node (two or more forward
// edges) becomes the continuation of a `block` its immediate dominator opens,
// every other edge target is emitted inline at its single predecessor. Phis
// are out-of-SSA locals assigned on each incoming edge with a parallel copy
// through the operand stack.
//
// There are no deoptimization exits: admission guarantees every operation is
// either native here or one synchronous host import. Java exceptions are host
// exceptions thrown by imports; a null dereference traps and the entry
// adapter converts the trap to NullPointerException (admitted methods have no
// exception handlers, so no frame inside the module can observe the
// difference).

const { VT, OP, GC, SAT, sleb, uleb, f32bytes, f64bytes, refNull } = require('./wasmBuilder');
const { T_OBJ, T_PARR, T_RARR, T_REFS, OBJ, PARR, RARR, KIND, KIND_SHIFT } = require('./representation');

const WT = { I: VT.i32, J: VT.i64, F: VT.f32, D: VT.f64, A: VT.anyref };
const ICONST = { iconst_m1: -1, iconst_0: 0, iconst_1: 1, iconst_2: 2, iconst_3: 3, iconst_4: 4, iconst_5: 5 };
const LCONST = { lconst_0: 0n, lconst_1: 1n };
const FCONST = { fconst_0: 0, fconst_1: 1, fconst_2: 2 };
const DCONST = { dconst_0: 0, dconst_1: 1 };
const BIN = {
  iadd: OP.i32_add, isub: OP.i32_sub, imul: OP.i32_mul, iand: OP.i32_and, ior: OP.i32_or, ixor: OP.i32_xor,
  ishl: OP.i32_shl, ishr: OP.i32_shr_s, iushr: OP.i32_shr_u,
  ladd: OP.i64_add, lsub: OP.i64_sub, lmul: OP.i64_mul, land: OP.i64_and, lor: OP.i64_or, lxor: OP.i64_xor,
  fadd: OP.f32_add, fsub: OP.f32_sub, fmul: OP.f32_mul, fdiv: OP.f32_div,
  dadd: OP.f64_add, dsub: OP.f64_sub, dmul: OP.f64_mul, ddiv: OP.f64_div,
};
const CONVERT = {
  i2l: [OP.i64_extend_i32_s], i2f: [OP.f32_convert_i32_s], i2d: [OP.f64_convert_i32_s],
  l2i: [OP.i32_wrap_i64], l2f: [OP.f32_convert_i64_s], l2d: [OP.f64_convert_i64_s],
  f2i: SAT.i32_trunc_sat_f32_s, f2l: SAT.i64_trunc_sat_f32_s, f2d: [OP.f64_promote_f32],
  d2i: SAT.i32_trunc_sat_f64_s, d2l: SAT.i64_trunc_sat_f64_s, d2f: [OP.f32_demote_f64],
  i2b: [OP.i32_extend8_s], i2s: [OP.i32_extend16_s],
};
// Primitive array element access by opcode: [kind letter, load ops, store ops, shift].
const PRIM_ARRAY = {
  iaload: ['I', [OP.i32_load, 2, 0]], laload: ['J', [OP.i64_load, 3, 0]], faload: ['F', [OP.f32_load, 2, 0]],
  daload: ['D', [OP.f64_load, 3, 0]], baload: ['I', [OP.i32_load8_s, 0, 0]], caload: ['I', [OP.i32_load16_u, 1, 0]],
  saload: ['I', [OP.i32_load16_s, 1, 0]],
  iastore: ['I', [OP.i32_store, 2, 0]], lastore: ['J', [OP.i64_store, 3, 0]], fastore: ['F', [OP.f32_store, 2, 0]],
  dastore: ['D', [OP.f64_store, 3, 0]], bastore: ['I', [OP.i32_store8, 0, 0]], castore: ['I', [OP.i32_store16, 1, 0]],
  sastore: ['I', [OP.i32_store16, 1, 0]],
};
const SHIFT = { iaload: 2, laload: 3, faload: 2, daload: 3, baload: 0, caload: 1, saload: 1,
  iastore: 2, lastore: 3, fastore: 2, dastore: 3, bastore: 0, castore: 1, sastore: 1 };

function zero(kind) {
  switch (kind) {
    case 'I': return [OP.i32_const, 0];
    case 'J': return [OP.i64_const, 0];
    case 'F': return [OP.f32_const, ...f32bytes(0)];
    case 'D': return [OP.f64_const, ...f64bytes(0)];
    default: return [OP.ref_null, VT.anyref];
  }
}

class Unsupported extends Error {}

// Operations that can raise a Java exception inside the module.
const THROWING = new Set(['idiv', 'irem', 'ldiv', 'lrem', 'getfield', 'putfield', 'arraylength', 'aaload', 'aastore',
  'iaload', 'laload', 'faload', 'daload', 'baload', 'caload', 'saload', 'iastore', 'lastore', 'fastore', 'dastore',
  'bastore', 'castore', 'sastore', 'invokestatic', 'invokespecial', 'invokevirtual', 'invokeinterface', 'new',
  'newarray', 'anewarray', 'multianewarray', 'checkcast', 'monitorenter', 'monitorexit', 'frem', 'drem']);
function mayThrow(node) { return THROWING.has(node.op) || !!(node.effects && node.effects.mayThrow); }

function successorsOf(term) {
  switch (term.kind) {
    case 'cond': return [term.taken, term.fall];
    case 'goto': case 'fall': return [term.target];
    case 'switch': return [...term.cases.map((c) => c.target), ...(term.default !== null && term.default !== undefined ? [term.default] : [])];
    default: return [];
  }
}

class ClosedCompiler {
  // world: ClosedWorld (import/function registry); entry: admitted method
  // record {key, fn, plan, isStatic, paramKinds, returnKind}.
  constructor(world, entry) {
    this.world = world;
    this.entry = entry;
    this.fn = entry.fn;
    this.plan = entry.plan;
    this.locals = [];          // extra local types beyond params
    this.localOfValue = new Map();
    this.scratch = new Map();  // type key -> [local indices] reused within one node
    this.paramCount = entry.paramKinds.length;
  }

  compile() {
    const fn = this.fn;
    fn.params.forEach((param, index) => this.localOfValue.set(param.id, index));
    // A handler local the handler never reads has no kind of its own, yet it
    // still carries the slot's value into the join after the handler. It
    // takes the kind of the phi it flows into.
    for (let changed = true; changed;) {
      changed = false;
      for (const block of fn.blocks) {
        for (const phi of block.phis) {
          if (!this.live(phi)) continue;
          for (const arg of phi.args) {
            if (arg && arg.op === 'handler_local' && !this.live(arg)) { arg.kind = phi.kind; changed = true; }
          }
        }
      }
    }
    this.analyzeControl();
    const code = [];
    // Entry phis seeded from parameters (a loop back to the method entry).
    const entryBlock = fn.blocks[fn.entry];
    if (entryBlock.phis.length && entryBlock.predIds[0] === 'entry') {
      code.push(...this.edgeCopies('entry', fn.entry));
    }
    // Uncovered null dereferences branch here (br_on_null) and throw NPE.
    // Covered ones throw at the site so their own handler can catch it.
    code.push(OP.block, 0x40);
    this.context = [{ kind: 'npe' }];
    this.tryDepth = 0;
    this.doTree(fn.entry, code);
    code.push(OP.unreachable, OP.end,
      OP.call, { fn: this.world.hostImport('err_npe', [], []) }, OP.unreachable);
    return { locals: this.locals, code };
  }

  // Leaves the non-null reference on the stack or throws NullPointerException.
  nonNull(refCode) {
    if (this.tryDepth === 0) return [...refCode, OP.br_on_null, ...uleb(this.depthOf('npe'))];
    const tmp = this.temp([VT.anyref]);
    const out = [...refCode, OP.local_tee, ...uleb(tmp), OP.ref_is_null, OP.if, 0x40,
      OP.call, { fn: this.world.hostImport('err_npe', [], []) }, OP.unreachable, OP.end,
      OP.local_get, ...uleb(tmp), OP.ref_as_non_null];
    this.release([VT.anyref], tmp);
    return out;
  }

  // Handler entries (table order) protecting an item, with their handler blocks.
  coveringEntries(itemIdx) {
    if (itemIdx === null || itemIdx === undefined || !this.entry.handlerBlocks) return [];
    return this.entry.handlerEntries.filter((h) => itemIdx >= h.startItemIdx && itemIdx < h.endItemIdx &&
      this.entry.handlerBlocks.has(h));
  }

  // ---- values -----------------------------------------------------------
  live(value) {
    return value && ['I', 'J', 'F', 'D', 'A'].includes(value.kind);
  }

  localFor(value) {
    let index = this.localOfValue.get(value.id);
    if (index === undefined) {
      index = this.paramCount + this.locals.length;
      this.locals.push([WT[value.kind]]);
      this.localOfValue.set(value.id, index);
    }
    return index;
  }

  use(value, kind) {
    if (!value || value.op === 'undef' || !this.live(value)) return zero(kind || value?.kind);
    if (value.op === 'aconst_null') return [OP.ref_null, VT.anyref];
    return [OP.local_get, ...uleb(this.localFor(value))];
  }

  set(value) { return [OP.local_set, ...uleb(this.localFor(value))]; }

  temp(typeBytes) {
    const key = JSON.stringify(typeBytes);
    const pool = this.scratchFree?.get(key);
    if (pool && pool.length) return pool.pop();
    const index = this.paramCount + this.locals.length;
    this.locals.push(typeBytes);
    return index;
  }

  release(typeBytes, index) {
    const key = JSON.stringify(typeBytes);
    (this.scratchFree ||= new Map());
    if (!this.scratchFree.has(key)) this.scratchFree.set(key, []);
    this.scratchFree.get(key).push(index);
  }

  // ---- control flow (Ramsey) ---------------------------------------------
  analyzeControl() {
    const fn = this.fn;
    const blocks = fn.blocks;
    const reachable = fn.reachable;
    const succ = new Map(), succAll = new Map();
    for (const id of reachable) {
      const all = successorsOf(blocks[id].term).filter((t) => reachable.has(t));
      // Exception edges: one per covered throwing site and handler, so a
      // handler reached from several sites is a merge node.
      for (const site of this.throwSites(id)) {
        for (const h of site.entries) all.push(this.entry.handlerBlocks.get(h));
      }
      succAll.set(id, all);
      succ.set(id, [...new Set(all)]);
    }
    // Reverse postorder from the entry.
    const post = [], seen = new Set();
    const stack = [[fn.entry, 0]];
    seen.add(fn.entry);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = succ.get(top[0]);
      if (top[1] < list.length) {
        const next = list[top[1]++];
        if (!seen.has(next)) { seen.add(next); stack.push([next, 0]); }
      } else {
        post.push(top[0]);
        stack.pop();
      }
    }
    const rpo = post.reverse();
    const rpoIndex = new Map(rpo.map((id, i) => [id, i]));
    // Dominators (Cooper-Harvey-Kennedy).
    const preds = new Map(rpo.map((id) => [id, []]));
    for (const id of rpo) for (const t of succ.get(id)) preds.get(t).push(id);
    const idom = new Map([[fn.entry, fn.entry]]);
    const intersect = (a, b) => {
      while (a !== b) {
        while (rpoIndex.get(a) > rpoIndex.get(b)) a = idom.get(a);
        while (rpoIndex.get(b) > rpoIndex.get(a)) b = idom.get(b);
      }
      return a;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const id of rpo) {
        if (id === fn.entry) continue;
        let next;
        for (const p of preds.get(id)) {
          if (!idom.has(p)) continue;
          next = next === undefined ? p : intersect(p, next);
        }
        if (next !== undefined && idom.get(id) !== next) { idom.set(id, next); changed = true; }
      }
    }
    const dominates = (a, b) => {
      for (let x = b; ; x = idom.get(x)) {
        if (x === a) return true;
        if (x === idom.get(x)) return false;
      }
    };
    const loopHeaders = new Set(), forward = new Map(rpo.map((id) => [id, 0]));
    for (const u of rpo) {
      for (const v of succAll.get(u)) {
        if (rpoIndex.get(v) <= rpoIndex.get(u)) {
          if (!dominates(v, u)) throw new Unsupported('irreducible control flow');
          loopHeaders.add(v);
        } else {
          forward.set(v, forward.get(v) + 1);
        }
      }
    }
    const children = new Map(rpo.map((id) => [id, []]));
    for (const id of rpo) if (id !== fn.entry) children.get(idom.get(id)).push(id);
    this.rpoIndex = rpoIndex;
    this.loopHeaders = loopHeaders;
    this.mergeNodes = new Set(rpo.filter((id) => forward.get(id) >= 2));
    this.children = children;
  }

  // Covered throwing sites of a block: {node|term, itemIdx, entries}.
  throwSites(blockId) {
    this.throwSiteCache ||= new Map();
    if (this.throwSiteCache.has(blockId)) return this.throwSiteCache.get(blockId);
    const block = this.fn.blocks[blockId];
    const sites = [];
    if (this.entry.handlerBlocks) {
      for (const node of block.body) {
        if (!mayThrow(node)) continue;
        const entries = this.coveringEntries(node.itemIdx);
        if (entries.length) sites.push({ node, itemIdx: node.itemIdx, entries });
      }
      if (block.term.insnOp === 'athrow') {
        const entries = this.coveringEntries(block.term.itemIdx);
        if (entries.length) sites.push({ term: block.term, itemIdx: block.term.itemIdx, entries });
      }
    }
    this.throwSiteCache.set(blockId, sites);
    return sites;
  }

  depthOf(kind, target) {
    for (let i = this.context.length - 1, depth = 0; i >= 0; i--, depth++) {
      const frame = this.context[i];
      if (frame.kind === kind && frame.target === target) return depth;
    }
    throw new Error(`no ${kind} label for block ${target}`);
  }

  doTree(x, out) {
    const merges = this.children.get(x).filter((y) => this.mergeNodes.has(y))
      .sort((a, b) => this.rpoIndex.get(b) - this.rpoIndex.get(a));
    if (this.loopHeaders.has(x)) {
      out.push(OP.loop, 0x40);
      this.context.push({ kind: 'loop', target: x });
      this.nodeWithin(x, merges, out);
      this.context.pop();
      out.push(OP.end, OP.unreachable);
    } else {
      this.nodeWithin(x, merges, out);
    }
  }

  nodeWithin(x, merges, out) {
    if (merges.length === 0) {
      this.emitBlockBody(x, out);
      this.emitTerminator(x, out);
      return;
    }
    const [y, ...rest] = merges;
    out.push(OP.block, 0x40);
    this.context.push({ kind: 'block', target: y });
    this.nodeWithin(x, rest, out);
    this.context.pop();
    out.push(OP.end);
    this.doTree(y, out);
  }

  doBranch(source, target, out, exceptional = false) {
    if (!exceptional) out.push(...this.edgeCopies(source, target));
    if (this.rpoIndex.get(target) <= this.rpoIndex.get(source)) {
      out.push(OP.br, ...uleb(this.depthOf('loop', target)));
    } else if (this.mergeNodes.has(target)) {
      out.push(OP.br, ...uleb(this.depthOf('block', target)));
    } else {
      this.doTree(target, out);
    }
  }

  // Parallel copy of `target`'s live phis for the edge from `source`.
  edgeCopies(source, target) {
    const block = this.fn.blocks[target];
    const phis = block.phis.filter((phi) => this.live(phi) && phi.uses.length);
    if (!phis.length) return [];
    const index = block.predIds.indexOf(source);
    if (index < 0) throw new Error(`edge ${source}->${target} missing from predIds`);
    const out = [];
    for (const phi of phis) out.push(...this.use(phi.args[index], phi.kind));
    for (let i = phis.length - 1; i >= 0; i--) out.push(...this.set(phis[i]));
    return out;
  }

  // ---- terminators ---------------------------------------------------------
  emitTerminator(x, out) {
    const term = this.fn.blocks[x].term;
    this.currentBlock = x;
    switch (term.kind) {
      case 'goto': case 'fall':
        this.doBranch(x, term.target, out);
        return;
      case 'cond':
        out.push(...this.condition(term), OP.if, 0x40);
        this.context.push({ kind: 'if' });
        this.doBranch(x, term.taken, out);
        out.push(OP.else);
        this.doBranch(x, term.fall, out);
        this.context.pop();
        out.push(OP.end, OP.unreachable);
        return;
      case 'switch':
        this.emitSwitch(x, term, out);
        return;
      case 'return':
        this.emitReturn(term, out);
        return;
      default:
        throw new Unsupported(`terminator ${term.kind}`);
    }
  }

  condition(term) {
    const [a, b] = term.args;
    const op = term.insnOp;
    const i = () => this.use(a, 'I');
    switch (op) {
      case 'ifeq': return [...i(), OP.i32_eqz];
      case 'ifne': return [...i(), OP.i32_const, 0, OP.i32_ne];
      case 'iflt': return [...i(), OP.i32_const, 0, OP.i32_lt_s];
      case 'ifge': return [...i(), OP.i32_const, 0, OP.i32_ge_s];
      case 'ifgt': return [...i(), OP.i32_const, 0, OP.i32_gt_s];
      case 'ifle': return [...i(), OP.i32_const, 0, OP.i32_le_s];
      case 'if_icmpeq': return [...i(), ...this.use(b, 'I'), OP.i32_eq];
      case 'if_icmpne': return [...i(), ...this.use(b, 'I'), OP.i32_ne];
      case 'if_icmplt': return [...i(), ...this.use(b, 'I'), OP.i32_lt_s];
      case 'if_icmpge': return [...i(), ...this.use(b, 'I'), OP.i32_ge_s];
      case 'if_icmpgt': return [...i(), ...this.use(b, 'I'), OP.i32_gt_s];
      case 'if_icmple': return [...i(), ...this.use(b, 'I'), OP.i32_le_s];
      case 'ifnull': return [...this.use(a, 'A'), OP.ref_is_null];
      case 'ifnonnull': return [...this.use(a, 'A'), OP.ref_is_null, OP.i32_eqz];
      case 'if_acmpeq': return this.referenceEquals(a, b);
      case 'if_acmpne': return [...this.referenceEquals(a, b), OP.i32_eqz];
      default: throw new Unsupported(`condition ${op}`);
    }
  }

  // Identity of two anyrefs. Closed storage is eq-comparable in Wasm; host
  // values (strings, JRE objects) compare in JS.
  referenceEquals(a, b) {
    if (a.op === 'aconst_null') return [...this.use(b, 'A'), OP.ref_is_null];
    if (b.op === 'aconst_null') return [...this.use(a, 'A'), OP.ref_is_null];
    const eq = (v) => [...this.use(v, 'A'), ...GC.ref_test_null, 0x6d];
    return [...eq(a), ...eq(b), OP.i32_and, OP.if, VT.i32,
      ...this.use(a, 'A'), ...GC.ref_cast_null, 0x6d, ...this.use(b, 'A'), ...GC.ref_cast_null, 0x6d, OP.ref_eq,
      OP.else, ...this.use(a, 'A'), ...this.use(b, 'A'), OP.call, { fn: this.world.hostImport('ref_eq', [VT.anyref, VT.anyref], [VT.i32]) },
      OP.end];
  }

  emitSwitch(x, term, out) {
    const key = term.args[0];
    const targets = [];
    const indexOfTarget = (t) => {
      let i = targets.indexOf(t);
      if (i < 0) { targets.push(t); i = targets.length - 1; }
      return i;
    };
    const def = term.default;
    if (def === null || def === undefined) throw new Unsupported('switch without default');
    const cases = term.cases.map((c) => ({ key: Number(c.key), slot: indexOfTarget(c.target) }));
    const defaultSlot = indexOfTarget(def);
    // One wasm block per distinct target: block_n ... block_0 { dispatch } edge(0) } edge(1) ...
    for (let i = targets.length - 1; i >= 0; i--) out.push(OP.block, 0x40);
    for (let i = targets.length - 1; i >= 0; i--) this.context.push({ kind: 'switch-arm' });
    const keys = cases.map((c) => c.key);
    const low = Math.min(...keys), high = Math.max(...keys);
    if (cases.length && high - low < 4096 && high - low <= cases.length * 4) {
      const table = new Array(high - low + 1).fill(defaultSlot);
      for (const c of cases) table[c.key - low] = c.slot;
      out.push(...this.use(key, 'I'), OP.i32_const, ...sleb(low), OP.i32_sub,
        OP.br_table, ...uleb(table.length), ...table.flatMap((slot) => uleb(slot)), ...uleb(defaultSlot));
    } else {
      for (const c of cases) {
        out.push(...this.use(key, 'I'), OP.i32_const, ...sleb(c.key), OP.i32_eq, OP.br_if, ...uleb(c.slot));
      }
      out.push(OP.br, ...uleb(defaultSlot));
    }
    for (let i = 0; i < targets.length; i++) {
      this.context.pop();
      out.push(OP.end);
      this.doBranch(x, targets[i], out);
    }
  }

  emitReturn(term, out) {
    const op = term.insnOp;
    if (op === 'athrow') {
      const site = this.throwSites(this.currentBlock).find((s) => s.term === term);
      const emit = (inner) => inner.push(...this.nonNull(this.use(term.args[0], 'A')), OP.throw, { tag: 'jx' });
      if (site) this.emitCovered(this.currentBlock, site, emit, out);
      else emit(out);
      out.push(OP.unreachable);
      return;
    }
    if (op === 'return') { out.push(OP.return); return; }
    const kind = this.entry.returnKind;
    out.push(...this.use(term.args[0], kind), OP.return);
  }

  // ---- straight-line nodes -----------------------------------------------
  emitBlockBody(x, out) {
    const sites = new Map(this.throwSites(x).filter((s) => s.node).map((s) => [s.node, s]));
    for (const node of this.fn.blocks[x].body) {
      const site = sites.get(node);
      if (site) this.emitCovered(x, site, (inner) => this.emitNode(node, inner), out);
      else this.emitNode(node, out);
    }
  }

  // try { op } catch $jx { first matching handler entry, else rethrow }.
  // Locals the handlers read are captured just before the op, which is the
  // frame state a Java handler observes.
  emitCovered(x, site, emit, out) {
    out.push(...this.handlerShadows(site));
    out.push(OP.try, 0x40);
    this.context.push({ kind: 'try' });
    this.tryDepth += 1;
    emit(out);
    this.tryDepth -= 1;
    const exc = this.temp([VT.anyref]);
    out.push(OP.catch, { tag: 'jx' }, OP.local_set, ...uleb(exc));
    for (const entry of site.entries) {
      const handler = this.entry.handlerBlocks.get(entry);
      const caught = this.fn.blocks[handler].body.find((n) => n.op === 'caught_exception');
      const enter = [];
      if (caught && caught.uses.length) enter.push(OP.local_get, ...uleb(exc), ...this.set(caught));
      const type = entry.catchType && entry.catchType !== 'any' ? entry.catchType : null;
      if (!type) {
        out.push(...enter);
        this.doBranch(x, handler, out, true);
        break;
      }
      out.push(OP.local_get, ...uleb(exc), OP.call, { fn: this.world.exceptionTypeImport(type) }, OP.if, 0x40);
      this.context.push({ kind: 'if' });
      out.push(...enter);
      this.doBranch(x, handler, out, true);
      this.context.pop();
      out.push(OP.end);
    }
    out.push(OP.local_get, ...uleb(exc), OP.throw, { tag: 'jx' });
    this.release([VT.anyref], exc);
    this.context.pop();
    out.push(OP.end);
  }

  handlerShadows(site) {
    const out = [];
    const defs = this.fn.slotDefsBefore?.get(site.itemIdx);
    for (const entry of site.entries) {
      const handler = this.entry.handlerBlocks.get(entry);
      for (const local of this.handlerLocals(handler)) {
        const def = defs?.get(local.imm.slot);
        out.push(...(def && def.kind === local.kind ? this.use(def, local.kind) : zero(local.kind)), ...this.set(local));
      }
    }
    return out;
  }

  handlerLocals(handler) {
    this.handlerLocalCache ||= new Map();
    if (!this.handlerLocalCache.has(handler)) {
      this.handlerLocalCache.set(handler, this.fn.values.filter((v) => v.op === 'handler_local' &&
        v.block === handler && this.live(v) && v.uses.length));
    }
    return this.handlerLocalCache.get(handler);
  }

  finish(node, out) {
    if (node.kind && node.kind !== 'V' && this.live(node)) out.push(...this.set(node));
    else if (node.kind && node.kind !== 'V') out.push(OP.drop);
  }

  emitNode(node, out) {
    const op = node.op;
    const arg = (i, kind) => this.use(node.args[i], kind);
    if (op === 'param' || op === 'phi' || op === 'caught_exception' || op === 'handler_local') return;
    if (op in ICONST) { out.push(OP.i32_const, ...sleb(ICONST[op])); return this.finish(node, out); }
    if (op in LCONST) { out.push(OP.i64_const, ...sleb(LCONST[op])); return this.finish(node, out); }
    if (op in FCONST) { out.push(OP.f32_const, ...f32bytes(FCONST[op])); return this.finish(node, out); }
    if (op in DCONST) { out.push(OP.f64_const, ...f64bytes(DCONST[op])); return this.finish(node, out); }
    if (op === 'aconst_null') { out.push(OP.ref_null, VT.anyref); return this.finish(node, out); }
    if (op === 'bipush' || op === 'sipush') { out.push(OP.i32_const, ...sleb(Number(node.imm))); return this.finish(node, out); }
    if (op === 'ldc' || op === 'ldc_w' || op === 'ldc2_w') { out.push(...this.constant(node)); return this.finish(node, out); }
    if (op === 'iinc') {
      out.push(...arg(0, 'I'), OP.i32_const, ...sleb(Number(node.imm.delta)), OP.i32_add);
      return this.finish(node, out);
    }
    if (BIN[op] !== undefined) { out.push(...arg(0, node.kind), ...arg(1, node.kind), BIN[op]); return this.finish(node, out); }
    if (op === 'lshl' || op === 'lshr' || op === 'lushr') {
      out.push(...arg(0, 'J'), ...arg(1, 'I'), OP.i64_extend_i32_s, { lshl: OP.i64_shl, lshr: OP.i64_shr_s, lushr: OP.i64_shr_u }[op]);
      return this.finish(node, out);
    }
    if (op === 'idiv' || op === 'irem' || op === 'ldiv' || op === 'lrem') { out.push(...this.division(node)); return this.finish(node, out); }
    if (op === 'frem' || op === 'drem') {
      const wide = op === 'drem';
      out.push(...arg(0, wide ? 'D' : 'F'), ...arg(1, wide ? 'D' : 'F'));
      const name = wide ? 'drem' : 'frem';
      const t = wide ? VT.f64 : VT.f32;
      out.push(OP.call, { fn: this.world.hostImport(name, [t, t], [t]) });
      return this.finish(node, out);
    }
    if (op === 'ineg') { out.push(OP.i32_const, 0, ...arg(0, 'I'), OP.i32_sub); return this.finish(node, out); }
    if (op === 'lneg') { out.push(OP.i64_const, 0, ...arg(0, 'J'), OP.i64_sub); return this.finish(node, out); }
    if (op === 'fneg') { out.push(...arg(0, 'F'), OP.f32_neg); return this.finish(node, out); }
    if (op === 'dneg') { out.push(...arg(0, 'D'), OP.f64_neg); return this.finish(node, out); }
    if (op === 'lcmp') {
      out.push(...arg(0, 'J'), ...arg(1, 'J'), OP.i64_gt_s, ...arg(0, 'J'), ...arg(1, 'J'), OP.i64_lt_s, OP.i32_sub);
      return this.finish(node, out);
    }
    if (op === 'fcmpl' || op === 'fcmpg' || op === 'dcmpl' || op === 'dcmpg') {
      const wide = op[0] === 'd', k = wide ? 'D' : 'F';
      const [gt, lt, ne] = wide ? [OP.f64_gt, OP.f64_lt, OP.f64_ne] : [OP.f32_gt, OP.f32_lt, OP.f32_ne];
      out.push(OP.i32_const, ...sleb(op.endsWith('g') ? 1 : -1));
      out.push(...arg(0, k), ...arg(1, k), gt, ...arg(0, k), ...arg(1, k), lt, OP.i32_sub);
      out.push(...arg(0, k), ...arg(0, k), ne, ...arg(1, k), ...arg(1, k), ne, OP.i32_or);
      out.push(OP.select);
      return this.finish(node, out);
    }
    if (CONVERT[op]) { out.push(...arg(0, null), ...CONVERT[op]); return this.finish(node, out); }
    if (op === 'i2c') { out.push(...arg(0, 'I'), OP.i32_const, ...sleb(0xffff), OP.i32_and); return this.finish(node, out); }
    if (PRIM_ARRAY[op]) { out.push(...this.primitiveArray(node)); return this.finish(node, out); }
    if (op === 'aaload' || op === 'aastore') { out.push(...this.referenceArray(node)); return this.finish(node, out); }
    if (op === 'arraylength') { out.push(...this.arrayLength(node)); return this.finish(node, out); }
    const plan = this.plan.get(node.id);
    if (!plan) throw new Unsupported(`no plan for ${op}`);
    if (plan.initClass) out.push(...this.initCheck(plan.initClass));
    out.push(...this.planned(node, plan));
    return this.finish(node, out);
  }

  constant(node) {
    const imm = node.imm;
    const plan = this.plan.get(node.id);
    if (plan && plan.kind === 'constant-global') {
      return [OP.global_get, { global: plan.global }, ...GC.any_convert_extern];
    }
    // The converted constant pool hands ints over as numbers, longs as
    // BigInts, and floats/doubles as {value, type}.
    if (typeof imm === 'number') return [OP.i32_const, ...sleb(imm | 0)];
    if (typeof imm === 'bigint') return [OP.i64_const, ...sleb(BigInt.asIntN(64, imm))];
    switch (imm && imm.type) {
      case 'Integer': case 'Int': return [OP.i32_const, ...sleb(Number(imm.value) | 0)];
      case 'Float': return [OP.f32_const, ...f32bytes(Number(imm.value))];
      case 'Long': return [OP.i64_const, ...sleb(BigInt.asIntN(64, BigInt(imm.value)))];
      case 'Double': return [OP.f64_const, ...f64bytes(Number(imm.value))];
      default: throw new Unsupported(`ldc ${typeof imm}:${String(imm?.type)}`);
    }
  }

  division(node) {
    const wide = node.op[0] === 'l', k = wide ? 'J' : 'I';
    const a = this.use(node.args[0], k), b = this.use(node.args[1], k);
    const c = wide ? OP.i64_const : OP.i32_const;
    const out = [...b, wide ? OP.i64_eqz : OP.i32_eqz, OP.if, 0x40,
      OP.call, { fn: this.world.hostImport('err_div0', [], []) }, OP.unreachable, OP.end];
    if (node.op === 'idiv' || node.op === 'ldiv') {
      // Java wraps MIN_VALUE / -1; Wasm traps. -x is the exact wrapped result.
      out.push(...b, c, ...sleb(wide ? -1n : -1), wide ? OP.i64_eq : OP.i32_eq, OP.if, wide ? VT.i64 : VT.i32,
        c, 0, ...a, wide ? OP.i64_sub : OP.i32_sub, OP.else, ...a, ...b, wide ? OP.i64_div_s : OP.i32_div_s, OP.end);
    } else {
      // MIN_VALUE % -1 traps in Wasm; Java gives 0, as does any x % -1.
      out.push(...b, c, ...sleb(wide ? -1n : -1), wide ? OP.i64_eq : OP.i32_eq, OP.if, wide ? VT.i64 : VT.i32,
        c, 0, OP.else, ...a, ...b, wide ? OP.i64_rem_s : OP.i32_rem_s, OP.end);
    }
    return out;
  }

  // ---- arrays -----------------------------------------------------------
  boundsCheck(indexCode, lengthLocal) {
    return [...indexCode, OP.local_get, ...uleb(lengthLocal), OP.i32_ge_u, OP.if, 0x40,
      ...indexCode, OP.local_get, ...uleb(lengthLocal),
      OP.call, { fn: this.world.hostImport('err_aioob', [VT.i32, VT.i32], []) }, OP.unreachable, OP.end];
  }

  primitiveArray(node) {
    const op = node.op;
    const [kind, [memOp, align]] = PRIM_ARRAY[op];
    const store = op.endsWith('astore');
    const shift = SHIFT[op];
    const t = WT[kind];
    const array = this.use(node.args[0], 'A'), index = this.use(node.args[1], 'I');
    const value = store ? this.use(node.args[2], kind) : [];
    const pType = refNull(T_PARR);
    const p = this.temp(pType), len = this.temp([VT.i32]);
    const host = this.world.hostImport(`${store ? 'astore' : 'aload'}_${kind}`,
      store ? [VT.anyref, VT.i32, t] : [VT.anyref, VT.i32], store ? [] : [t]);
    const address = [OP.local_get, ...uleb(p), ...GC.struct_get, { type: T_PARR }, PARR.base,
      ...index, ...(shift ? [OP.i32_const, shift, OP.i32_shl] : []), OP.i32_add];
    const out = [...array, ...GC.ref_test, { stype: T_PARR }, OP.if, store ? 0x40 : t,
      ...array, ...GC.ref_cast, { stype: T_PARR }, OP.local_tee, ...uleb(p),
      ...GC.struct_get, { type: T_PARR }, PARR.len, OP.local_set, ...uleb(len),
      ...this.boundsCheck(index, len),
      ...address, ...value, memOp, align, 0,
      OP.else, ...array, ...index, ...value, OP.call, { fn: host }, OP.end];
    this.release(pType, p);
    this.release([VT.i32], len);
    return out;
  }

  referenceArray(node) {
    const store = node.op === 'aastore';
    const array = this.use(node.args[0], 'A'), index = this.use(node.args[1], 'I');
    const value = store ? this.use(node.args[2], 'A') : [];
    const eType = refNull(T_REFS);
    const e = this.temp(eType), len = this.temp([VT.i32]);
    const host = this.world.hostImport(store ? 'aastore' : 'aaload',
      store ? [VT.anyref, VT.i32, VT.anyref] : [VT.anyref, VT.i32], store ? [] : [VT.anyref]);
    const out = [...array, ...GC.ref_test, { stype: T_RARR }, OP.if, store ? 0x40 : VT.anyref,
      ...array, ...GC.ref_cast, { stype: T_RARR }, ...GC.struct_get, { type: T_RARR }, RARR.elems,
      OP.local_tee, ...uleb(e), ...GC.array_len, OP.local_set, ...uleb(len),
      ...this.boundsCheck(index, len),
      OP.local_get, ...uleb(e), ...index, ...value, ...(store ? GC.array_set : GC.array_get), { type: T_REFS },
      OP.else, ...array, ...index, ...value, OP.call, { fn: host }, OP.end];
    this.release(eType, e);
    this.release([VT.i32], len);
    return out;
  }

  arrayLength(node) {
    const array = this.use(node.args[0], 'A');
    return [...array, ...GC.ref_test, { stype: T_PARR }, OP.if, VT.i32,
      ...array, ...GC.ref_cast, { stype: T_PARR }, ...GC.struct_get, { type: T_PARR }, PARR.len,
      OP.else, ...array, ...GC.ref_test, { stype: T_RARR }, OP.if, VT.i32,
      ...array, ...GC.ref_cast, { stype: T_RARR }, ...GC.struct_get, { type: T_RARR }, RARR.elems, ...GC.array_len,
      OP.else, ...array, OP.call, { fn: this.world.hostImport('alen', [VT.anyref], [VT.i32]) }, OP.end, OP.end];
  }

  // ---- planned operations (fields, statics, calls, allocation, casts) -----
  planned(node, plan) {
    const arg = (i, kind) => this.use(node.args[i], kind);
    switch (plan.kind) {
      case 'field-get': return this.fieldAccess(node, plan, false);
      case 'field-put': return this.fieldAccess(node, plan, true);
      case 'static-get': return this.staticGet(plan);
      case 'static-put': return [...arg(0, plan.valueKind), ...this.staticPut(plan)];
      case 'call': return this.call(node, plan);
      case 'virtual': return this.virtualCall(node, plan);
      case 'noop': return [];
      case 'import': {
        // Generic synchronous host operation: arguments in order, one call.
        const code = [];
        plan.argKinds.forEach((kind, i) => code.push(...arg(i, kind)));
        code.push(OP.call, { fn: plan.fn });
        return code;
      }
      case 'intrinsic': return this.intrinsic(node, plan);
      case 'instanceof': return this.typeTest(node, plan, false);
      case 'checkcast': return this.typeTest(node, plan, true);
      default: throw new Unsupported(`plan ${plan.kind}`);
    }
  }

  // Lazy class initialization: one load of the class's readiness word; only
  // the first access calls out to run the initializer.
  initCheck(target) {
    const init = this.world.hostImport('init', [VT.i32], []);
    const call = [OP.i32_const, ...sleb(target.id), OP.call, { fn: init }];
    if (target.address === null) return call;
    return [OP.i32_const, ...sleb(target.address), OP.i32_load, 2, 0, OP.i32_eqz, OP.if, 0x40, ...call, OP.end];
  }

  intrinsic(node, plan) {
    const k = plan.argKinds[0];
    const a = this.use(node.args[0], k), b = node.args[1] ? this.use(node.args[1], k) : [];
    switch (plan.op) {
      case 'f64.sqrt': return [...a, OP.f64_sqrt];
      case 'f32.abs': return [...a, OP.f32_abs];
      case 'f64.abs': return [...a, OP.f64_abs];
      case 'f64.floor': return [...a, OP.f64_floor];
      case 'f64.ceil': return [...a, OP.f64_ceil];
      case 'f64.nearest': return [...a, OP.f64_nearest];
      case 'f32.min': return [...a, ...b, OP.f32_min];
      case 'f32.max': return [...a, ...b, OP.f32_max];
      case 'f64.min': return [...a, ...b, OP.f64_min];
      case 'f64.max': return [...a, ...b, OP.f64_max];
      // Integer abs wraps at MIN_VALUE exactly like Java: (x ^ s) - s, s = x >> 31.
      case 'i32.abs': return [...a, ...a, OP.i32_const, 31, OP.i32_shr_s, OP.i32_xor, ...a, OP.i32_const, 31, OP.i32_shr_s, OP.i32_sub];
      case 'i64.abs': return [...a, ...a, OP.i64_const, 63, OP.i64_shr_s, OP.i64_xor, ...a, OP.i64_const, 63, OP.i64_shr_s, OP.i64_sub];
      case 'i32.min': return [...a, ...b, ...a, ...b, OP.i32_lt_s, OP.select];
      case 'i32.max': return [...a, ...b, ...a, ...b, OP.i32_gt_s, OP.select];
      case 'i64.min': return [...a, ...b, ...a, ...b, OP.i64_lt_s, OP.select];
      case 'i64.max': return [...a, ...b, ...a, ...b, OP.i64_gt_s, OP.select];
      default: throw new Unsupported(`intrinsic ${plan.op}`);
    }
  }

  fieldAccess(node, plan, isPut) {
    const object = this.use(node.args[0], 'A');
    const value = isPut ? this.use(node.args[1], plan.valueKind) : [];
    const cast = [...this.nonNull(object), ...GC.ref_cast, { stype: T_OBJ }];
    if (plan.reference) {
      return [...cast, ...GC.struct_get, { type: T_OBJ }, OBJ.refs, OP.i32_const, ...sleb(plan.index),
        ...value, ...(isPut ? GC.array_set : GC.array_get), { type: T_REFS }];
    }
    const base = [...cast, ...GC.struct_get, { type: T_OBJ }, OBJ.base];
    const memarg = (align) => [align, ...uleb(plan.offset)];
    switch (plan.slotKind) {
      case 'i32': return isPut ? [...base, ...value, OP.i32_store, ...memarg(2)] : [...base, OP.i32_load, ...memarg(2)];
      case 'i64': return isPut ? [...base, ...value, OP.i64_store, ...memarg(3)] : [...base, OP.i64_load, ...memarg(3)];
      case 'f64':
        if (plan.valueKind === 'F') {
          return isPut ? [...base, ...value, OP.f64_promote_f32, OP.f64_store, ...memarg(3)]
            : [...base, OP.f64_load, ...memarg(3), OP.f32_demote_f64];
        }
        return isPut ? [...base, ...value, OP.f64_store, ...memarg(3)] : [...base, OP.f64_load, ...memarg(3)];
      default: throw new Unsupported(`field slot ${plan.slotKind}`);
    }
  }

  staticGet(plan) {
    return [OP.global_get, { global: plan.global }];
  }

  staticPut(plan) {
    return [OP.global_set, { global: plan.global }];
  }

  callArgs(node, plan) {
    const code = [];
    plan.argKinds.forEach((kind, i) => code.push(...this.use(node.args[i], kind)));
    return code;
  }

  call(node, plan) {
    const code = [];
    if (plan.nullCheckReceiver) code.push(...this.nonNull(this.use(node.args[0], 'A')), OP.drop);
    code.push(...this.callArgs(node, plan), OP.call, { fn: plan.fn });
    return code;
  }

  // Dispatch on the receiver's class id among the admitted implementations.
  // Host receivers (strings, JRE objects) take one host call when the site
  // allows them; an unknown class id is a loud closed-world failure.
  virtualCall(node, plan) {
    const receiver = this.use(node.args[0], 'A');
    const resultType = plan.returnKind === 'V' ? 0x40 : WT[plan.returnKind];
    const cls = this.temp([VT.i32]);
    const args = this.callArgs(node, plan);
    const code = [...this.nonNull(receiver), OP.drop];
    code.push(...receiver, ...GC.ref_test, { stype: T_OBJ }, OP.if, resultType,
      ...receiver, ...GC.ref_cast, { stype: T_OBJ }, ...GC.struct_get, { type: T_OBJ }, OBJ.cls, OP.local_set, ...uleb(cls));
    const arms = plan.targets; // [{classIds:[...], fn}]
    let open = 0;
    for (const arm of arms) {
      for (let i = 0; i < arm.classIds.length; i++) {
        code.push(OP.local_get, ...uleb(cls), OP.i32_const, ...sleb(arm.classIds[i]), OP.i32_eq);
        if (i) code.push(OP.i32_or);
      }
      code.push(OP.if, resultType, ...args, OP.call, { fn: arm.fn }, OP.else);
      open += 1;
    }
    code.push(OP.local_get, ...uleb(cls), OP.i32_const, ...sleb(plan.siteId),
      OP.call, { fn: this.world.hostImport('vmiss', [VT.i32, VT.i32], []) }, OP.unreachable);
    for (let i = 0; i < open; i++) code.push(OP.end);
    code.push(OP.else);
    if (plan.hostFn) code.push(...args, OP.call, { fn: plan.hostFn });
    else code.push(OP.i32_const, ...sleb(-1), OP.i32_const, ...sleb(plan.siteId),
      OP.call, { fn: this.world.hostImport('vmiss', [VT.i32, VT.i32], []) }, OP.unreachable);
    code.push(OP.end);
    this.release([VT.i32], cls);
    return code;
  }

  // instanceof / checkcast. Guest class targets test the class id in Wasm;
  // primitive array targets test the $parr kind; everything else asks JS.
  typeTest(node, plan, isCast) {
    const value = this.use(node.args[0], 'A');
    let test;
    if (plan.classIds) {
      const cls = this.temp([VT.i32]);
      test = [...value, ...GC.ref_test, { stype: T_OBJ }, OP.if, VT.i32,
        ...value, ...GC.ref_cast, { stype: T_OBJ }, ...GC.struct_get, { type: T_OBJ }, OBJ.cls, OP.local_set, ...uleb(cls)];
      if (!plan.classIds.length) test.push(OP.i32_const, 0);
      plan.classIds.forEach((id, i) => {
        test.push(OP.local_get, ...uleb(cls), OP.i32_const, ...sleb(id), OP.i32_eq);
        if (i) test.push(OP.i32_or);
      });
      test.push(OP.else, OP.i32_const, 0, OP.end);
      this.release([VT.i32], cls);
    } else if (plan.primitiveKind !== undefined) {
      test = [...value, ...GC.ref_test, { stype: T_PARR }, OP.if, VT.i32,
        ...value, ...GC.ref_cast, { stype: T_PARR }, ...GC.struct_get, { type: T_PARR }, PARR.kind,
        OP.i32_const, ...sleb(plan.primitiveKind), OP.i32_eq, OP.else, OP.i32_const, 0, OP.end];
    } else if (plan.always) {
      test = [OP.i32_const, 1];
    } else {
      test = [...value, OP.call, { fn: plan.hostFn }];
    }
    // null: instanceof is false; checkcast passes.
    const nullCase = isCast ? [OP.i32_const, 1] : [OP.i32_const, 0];
    const result = [...value, OP.ref_is_null, OP.if, VT.i32, ...nullCase, OP.else, ...test, OP.end];
    if (!isCast) return result;
    return [...result, OP.i32_eqz, OP.if, 0x40, ...value, OP.i32_const, ...sleb(plan.siteId),
      OP.call, { fn: this.world.hostImport('err_cce', [VT.anyref, VT.i32], []) }, OP.unreachable, OP.end,
      ...value];
  }
}

module.exports = { ClosedCompiler, Unsupported, WT, successorsOf };
