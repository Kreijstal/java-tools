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

const { VT, HT, OP, GC, SAT, sleb, uleb, f32bytes, f64bytes, refNull } = require('./wasmBuilder');
const { T_OBJ, T_PARR, T_RARR, T_REFS, OBJ, PARR, RARR, KIND, KIND_SHIFT } = require('./representation');
const {primitiveSpillArrayImport} = require('./primitiveSpillArray');

const WT = { I: VT.i32, J: VT.i64, F: VT.f32, D: VT.f64, A: VT.anyref };
const KIND_OF_VT = new Map(Object.entries(WT).map(([kind, vt]) => [vt, kind]));
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

// A representation with its own Wasm reference type (see
// ClosedWorld.reprSubtype for the lattice).
const typed = (repr) => !!repr && repr !== 'any' && repr !== 'null';
const NULL_REF = [OP.ref_null, HT.none];

function zero(kind) {
  switch (kind) {
    case 'I': return [OP.i32_const, 0];
    case 'J': return [OP.i64_const, 0];
    case 'F': return [OP.f32_const, ...f32bytes(0)];
    case 'D': return [OP.f64_const, ...f64bytes(0)];
    default: return NULL_REF;
  }
}

class Unsupported extends Error {}
// Every null check names its site (JVM_CLOSED_WORLD_DEBUG_NPE=1).
const DEBUG_NPE = typeof process !== 'undefined' && process.env.JVM_CLOSED_WORLD_DEBUG_NPE === '1';

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
    this.inferHandlerLocalKinds();
    this.markShadowedHandlerLocals();
    this.inferReprs();
    this.analyzeControl();
    this.analyzeInvariantReceiverFields();
    const code = [];
    // Depth accounting (ClosedWorld.markRecursion): a method on a call cycle
    // counts its frame and throws StackOverflowError past the JVM's limit; a
    // method with handlers remembers its depth, since an exception unwinds
    // the counted frames above it without their returns.
    const recursive = !!this.entry.recursive;
    if (recursive || this.entry.handlerBlocks?.size) {
      const depth = [OP.global_get, { global: 'depth' }];
      this.depthLocal = this.local([VT.i32]);
      const d = uleb(this.depthLocal);
      if (!recursive) code.push(...depth, OP.local_set, ...d);
      else {
        code.push(...depth, OP.i32_const, ...sleb(1), OP.i32_add, OP.local_tee, ...d, OP.global_set, { global: 'depth' },
          OP.local_get, ...d, OP.i32_const, ...sleb(this.world.jvm.maxStackDepth || 1024), OP.i32_gt_s, OP.if, 0x40,
          OP.call, { fn: this.world.hostImport('err_soe', [], []) }, OP.unreachable, OP.end);
      }
    }
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
    this.checked = new Set();
    this.analyzeDerived();
    for (const param of fn.params) code.push(...this.deriveCode(param));
    for (const node of this.invariantReceiverFields) {
      this.currentNode = node;
      code.push(...this.fieldAccess(node, this.plan.get(node.id), false), ...this.set(node));
    }
    this.doTree(fn.entry, code);
    code.push(OP.unreachable, OP.end,
      OP.call, { fn: this.world.hostImport('err_npe', [], []) }, OP.unreachable);
    return { locals: this.locals, code };
  }

  // Leaves the non-null reference on the stack or throws NullPointerException.
  // `refCode` is always a side-effect-free local.get (or ref.null), so the
  // covered form reads it twice and keeps its static type.
  nonNull(refCode) {
    if (DEBUG_NPE) {
      const site = this.world.sites.push({ where: `${this.entry.key}@${this.currentNode?.op}:${this.currentNode?.pc}` }) - 1;
      return [...refCode, OP.ref_is_null, OP.if, 0x40, OP.i32_const, ...sleb(site),
        OP.call, { fn: this.world.hostImport('err_npe_at', [VT.i32], []) }, OP.unreachable, OP.end, ...refCode, OP.ref_as_non_null];
    }
    if (this.tryDepth === 0) return [...refCode, OP.br_on_null, ...uleb(this.depthOf('npe'))];
    // Covered: a handler may read the message, so a null receiver of an
    // instance invoke carries the context the interpreter's NPE carries.
    const node = this.currentNode, method = this.entry.method;
    const items = method?.attributes?.find((a) => a.type === 'code')?.code?.codeItems;
    const thrower = (node && (node.op === 'invokevirtual' || node.op === 'invokeinterface') && items && items[node.itemIdx])
      ? [OP.i32_const, ...sleb(this.world.sites.push({ where: `${this.entry.key}@${node.itemIdx}`,
        npe: { items, item: items[node.itemIdx], owner: node.imm[1], name: node.imm[2][0] } }) - 1),
        OP.call, { fn: this.world.hostImport('err_npe_invoke', [VT.i32], []) }]
      : [OP.call, { fn: this.world.hostImport('err_npe', [], []) }];
    return [...refCode, OP.ref_is_null, OP.if, 0x40, ...thrower, OP.unreachable, OP.end,
      ...refCode, OP.ref_as_non_null];
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
      this.locals.push(this.world.wasmType(value.kind, this.reprOf(value)));
      this.localOfValue.set(value.id, index);
    }
    return index;
  }

  use(value, kind) {
    if (!value || value.op === 'undef' || !this.live(value)) return zero(kind || value?.kind);
    if (value.op === 'aconst_null' || this.reprOf(value) === 'null') return NULL_REF;
    return [OP.local_get, ...uleb(this.localFor(value))];
  }

  // A reference value as `repr` (a typed callee parameter or return).
  useAs(value, kind, repr) {
    const code = this.use(value, kind);
    if (kind !== 'A' || !typed(repr) || !value || value.op === 'aconst_null' || !this.live(value)) return code;
    return this.world.reprSubtype(this.reprOf(value), repr) ? code : [...code, ...this.castTo(repr)];
  }

  castTo(repr) { return [...GC.ref_cast_null, { stype: this.world.typeOfRepr(repr) }]; }

  // ---- reference representations ---------------------------------------
  // Each reference value's closed representation, from the Java static types
  // bytecode gives it (descriptors, checkcast, allocation), joined at phis.
  inferReprs() {
    const world = this.world, fn = this.fn, entry = this.entry;
    const types = new Map(); // id -> {desc, repr} ; null type = only null so far
    const NULL = { desc: null, repr: 'null' };
    const ANY = { desc: null, repr: 'any' };
    const ofDesc = (desc) => ({ desc, repr: world.reprOfDescriptor(desc) });
    const join = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      if (a.repr === 'null') return b;
      if (b.repr === 'null') return a;
      return { desc: a.desc === b.desc ? a.desc : null, repr: world.reprJoin(a.repr, b.repr) };
    };
    const classDesc = (name) => (name.startsWith('[') ? name : `L${name};`);
    const typeOf = (value) => {
      switch (value.op) {
        case 'param': {
          const i = value.imm.index;
          if (!entry.isStatic && i === 0) return { desc: classDesc(entry.className), repr: entry.paramReprs[0] };
          return { desc: entry.paramDescriptors[i - (entry.isStatic ? 0 : 1)], repr: entry.paramReprs[i] };
        }
        case 'aconst_null': return NULL;
        case 'getfield': case 'getstatic': return ofDesc(value.imm[2][1]);
        case 'invokestatic': case 'invokespecial': case 'invokevirtual': case 'invokeinterface': {
          const d = value.imm[2][1];
          return ofDesc(d.slice(d.indexOf(')') + 1));
        }
        case 'aaload': {
          const array = types.get(value.args[0]?.id);
          return array && array.desc && array.desc[0] === '[' ? ofDesc(array.desc.slice(1)) : ANY;
        }
        case 'checkcast': return ofDesc(classDesc(value.imm));
        case 'new': return ofDesc(classDesc(value.imm));
        case 'newarray': {
          const letter = { boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D',
            4: 'Z', 5: 'C', 6: 'F', 7: 'D', 8: 'B', 9: 'S', 10: 'I', 11: 'J' }[value.imm];
          return letter ? ofDesc(`[${letter}`) : ANY;
        }
        case 'anewarray': return ofDesc(`[${classDesc(value.imm)}`);
        case 'multianewarray': return ofDesc(Array.isArray(value.imm) ? value.imm[0] : value.imm);
        case 'phi': return value.args.reduce((t, arg) => (arg && this.live(arg) ? join(t, types.get(arg.id)) : t), null);
        default: return ANY;
      }
    };
    const refs = fn.values.filter((v) => v.kind === 'A');
    const settle = () => {
      for (let changed = true, rounds = 0; changed; rounds++) {
        if (rounds > 64) throw new Unsupported('reference types did not settle');
        changed = false;
        for (const value of refs) {
          const next = typeOf(value);
          const prev = types.get(value.id);
          if (next && (!prev || prev.repr !== next.repr || prev.desc !== next.desc)) {
            types.set(value.id, next);
            changed = true;
          }
        }
      }
    };
    settle();
    // Unseeded phi cycles have no discovered representation. Their values
    // still occupy anyref locals; treating that absence like a null input
    // incorrectly narrows downstream phis and emits invalid typed copies.
    const unresolved = refs.filter(value => !types.has(value.id));
    if (unresolved.length) {
      for (const value of unresolved) types.set(value.id, ANY);
      settle();
    }
    // A proven null-only phi can be emitted as the reference bottom type,
    // rather than read from an anyref local on a typed incoming edge.
    this.reprs = new Map([...types].map(([id, t]) => [id, t.repr]));
  }

  reprOf(value) { return (value && this.reprs?.get(value.id)) || 'any'; }

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
    // Class initialization checks already done on every path to x stay done
    // in x's dominator subtree. A handler block is entered from the middle of
    // its throwing block, so it starts with nothing assumed.
    const saved = this.checked;
    this.checked = this.fn.blocks[x].isHandlerEntry ? new Set() : new Set(saved);
    this.doTreeInner(x, out);
    this.checked = saved;
  }

  doTreeInner(x, out) {
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
    const phis = block.phis.filter((phi) => this.live(phi) && (phi.uses.length || this.shadowedHandlerLocals?.has(phi)));
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
    const leave = this.entry.recursive
      ? [OP.local_get, ...uleb(this.depthLocal), OP.i32_const, ...sleb(1), OP.i32_sub, OP.global_set, { global: 'depth' }] : [];
    if (op === 'return') { out.push(...leave, OP.return); return; }
    const kind = this.entry.returnKind;
    out.push(...this.useAs(term.args[0], kind, this.entry.returnRepr), ...leave, OP.return);
  }

  // ---- straight-line nodes -----------------------------------------------
  // Array stores cannot alias an object's primitive fields. In a method with
  // no field writes, calls, class initialization or synchronization, ordinary
  // receiver fields therefore stay constant across its pixel/element loops.
  // Read them once at entry. Only `this` is eligible: reading another receiver
  // early could move a NullPointerException before an observable array store.
  analyzeInvariantReceiverFields() {
    this.invariantReceiverFields = [];
    this.invariantReceiverFieldNodes = new Set();
    if (this.entry.isStatic || !this.loopHeaders.size) return;
    const nodes = [...this.fn.reachable].flatMap(id => this.fn.blocks[id].body);
    const fields = new Map();
    for (const node of nodes) {
      const plan = this.plan.get(node.id);
      if (plan && (plan.initClass || !['field-get', 'intrinsic', 'constant-global'].includes(plan.kind))) return;
      if (node.op === 'monitorenter' || node.op === 'monitorexit') return;
      if (node.op !== 'getfield') continue;
      if (plan?.kind !== 'field-get') return;
      const [, , [name, descriptor]] = node.imm;
      const declaration = this.world.classAst(plan.declaring)?.items.find(item =>
        item.type === 'field' && item.field.name === name && item.field.descriptor === descriptor)?.field;
      // A volatile read is an acquire even when its result is unused. It can
      // make other threads' writes visible, so none of the reads may move.
      if (!declaration || declaration.flags?.includes('volatile') || (declaration.accessFlags & 0x0040)) return;
      const receiver = node.args[0];
      if (plan.reference || receiver?.op !== 'param' || receiver.imm.index !== 0) continue;
      const key = `${plan.declaring}.${name}:${descriptor}`;
      if (!fields.has(key)) fields.set(key, []);
      fields.get(key).push(node);
    }
    for (const reads of fields.values()) {
      const first = reads[0], local = this.localFor(first);
      this.invariantReceiverFields.push(first);
      for (const node of reads) {
        this.localOfValue.set(node.id, local);
        this.invariantReceiverFieldNodes.add(node);
      }
    }
  }

  emitBlockBody(x, out) {
    const block = this.fn.blocks[x];
    for (const phi of block.phis) out.push(...this.deriveCode(phi));
    if (block.isHandlerEntry) {
      for (const value of this.fn.values) {
        if (value.block === x && (value.op === 'handler_local' || value.op === 'caught_exception')) out.push(...this.deriveCode(value));
      }
    }
    const sites = new Map(this.throwSites(x).filter((s) => s.node).map((s) => [s.node, s]));
    for (const node of block.body) {
      if (this.invariantReceiverFieldNodes.has(node)) continue;
      const site = sites.get(node);
      if (site) this.emitCovered(x, site, (inner) => this.emitNode(node, inner), out);
      else this.emitNode(node, out);
      if (node.op !== 'caught_exception') out.push(...this.deriveCode(node));
    }
  }

  // ---- per-value caches -------------------------------------------------
  // A value used as an object in field accesses, or as an array, gets its
  // representation decoded once where it is defined: the object's slab base
  // and $obj ref, the array's base/length (or a flag sending a foreign array
  // to the host path). Each access then needs no cast or struct.get.
  analyzeDerived() {
    this.derived = new Map();
    const want = (value, kind) => {
      if (!value || !this.live(value) || value.op === 'aconst_null' || value.kind !== 'A') return;
      // A typed value is read directly: V8 shares its immutable struct
      // fields and null checks; decoded locals would only lengthen live
      // ranges across calls.
      if (typed(this.reprOf(value))) return;
      let entry = this.derived.get(value.id);
      if (!entry) { entry = {}; this.derived.set(value.id, entry); }
      if (entry[kind]) return;
      if (kind === 'parr') entry.parr = { base: this.local([VT.i32]), len: this.local([VT.i32]) };
      if (kind === 'rarr') entry.rarr = { elems: this.local(refNull(T_REFS)), len: this.local([VT.i32]) };
    };
    for (const id of this.fn.reachable) {
      for (const node of this.fn.blocks[id].body) {
        const plan = this.plan.get(node.id);
        if (PRIM_ARRAY[node.op]) want(node.args[0], 'parr');
        if (node.op === 'aaload' || node.op === 'aastore') want(node.args[0], 'rarr');
      }
    }
  }

  local(typeBytes) {
    const index = this.paramCount + this.locals.length;
    this.locals.push(typeBytes);
    return index;
  }

  deriveCode(value) {
    const entry = this.derived.get(value.id);
    if (!entry) return [];
    const v = this.use(value, 'A');
    const out = [];
    const L = (i) => uleb(i);
    const repr = this.reprOf(value);
    // `this` is never null.
    const nonNull = value.op === 'param' && value.imm.index === 0 && !this.entry.isStatic;
    const ifNull = (onNull, onValue) => (nonNull ? onValue
      : [...v, OP.ref_is_null, OP.if, 0x40, ...onNull, OP.else, ...onValue, OP.end]);
    // Arrays decode to base/elems and length. Null decodes with length 0, so
    // the access's one unsigned bounds check also raises its
    // NullPointerException. A primitive array outside closed storage is a
    // closed-world defect and fails here; that keeps every slow path a throw,
    // with no call returning into the access.
    if (entry.parr && repr === 'parr') {
      const { base, len } = entry.parr;
      out.push(...ifNull([OP.i32_const, 0, OP.local_set, ...L(len)],
        [...v, ...GC.struct_get, { type: T_PARR }, PARR.base, OP.local_set, ...L(base),
          ...v, ...GC.struct_get, { type: T_PARR }, PARR.len, OP.local_set, ...L(len)]));
    } else if (entry.parr) {
      const { base, len } = entry.parr;
      const tmp = this.temp(refNull(T_PARR));
      out.push(...v, ...GC.ref_test, { stype: T_PARR }, OP.if, 0x40,
        ...v, ...GC.ref_cast, { stype: T_PARR }, OP.local_tee, ...L(tmp), ...GC.struct_get, { type: T_PARR }, PARR.base,
        OP.local_set, ...L(base), OP.local_get, ...L(tmp), ...GC.struct_get, { type: T_PARR }, PARR.len, OP.local_set, ...L(len),
        OP.else, ...v, OP.ref_is_null, OP.i32_eqz, OP.if, 0x40,
        ...v, OP.call, { fn: this.world.hostImport('err_foreign', [VT.anyref], []) }, OP.unreachable, OP.end,
        OP.i32_const, 0, OP.local_set, ...L(len), OP.end);
      this.release(refNull(T_PARR), tmp);
    }
    if (entry.rarr && repr === 'rarr') {
      const { elems, len } = entry.rarr;
      out.push(...ifNull([OP.i32_const, 0, OP.local_set, ...L(len)],
        [...v, ...GC.struct_get, { type: T_RARR }, RARR.elems, OP.local_tee, ...L(elems),
          ...GC.array_len, OP.local_set, ...L(len)]));
    } else if (entry.rarr) {
      const { elems, len } = entry.rarr;
      out.push(...v, ...GC.ref_test, { stype: T_RARR }, OP.if, 0x40,
        ...v, ...GC.ref_cast, { stype: T_RARR }, ...GC.struct_get, { type: T_RARR }, RARR.elems, OP.local_tee, ...L(elems),
        ...GC.array_len, OP.local_set, ...L(len),
        OP.else, ...v, OP.ref_is_null, OP.i32_eqz, OP.if, 0x40,
        ...v, OP.call, { fn: this.world.hostImport('err_foreign', [VT.anyref], []) }, OP.unreachable, OP.end,
        OP.i32_const, 0, OP.local_set, ...L(len), OP.end);
    }
    return out;
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
    if (this.depthLocal !== undefined) out.push(OP.local_get, ...uleb(this.depthLocal), OP.global_set, { global: 'depth' });
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
        v.block === handler && this.wantedHandlerLocal(v)));
    }
    return this.handlerLocalCache.get(handler);
  }

  // A handler local read directly (not through a phi) may reach here without
  // a kind; it receives the slot's value at the covered throw sites, so it
  // takes that value's kind (javac.js output: an i2l of an int local in a
  // handler compiled to i2l of a null reference).
  inferHandlerLocalKinds() {
    if (!this.entry.handlerBlocks?.size || !this.fn.slotDefsBefore) return;
    // Phi inputs take the phi's kind (compile()); this is for direct readers.
    const pending = this.fn.values.filter((v) => v.op === 'handler_local' && !this.live(v)
      && v.uses.some((use) => use.op !== 'phi'));
    if (!pending.length) return;
    const handlerOf = new Map();
    for (const [entry, block] of this.entry.handlerBlocks) {
      if (!handlerOf.has(block)) handlerOf.set(block, []);
      handlerOf.get(block).push(entry);
    }
    for (const v of pending) {
      const covered = new Set(handlerOf.get(v.block) || []);
      const kinds = new Set();
      for (let blockId = 0; blockId < this.fn.blocks.length; blockId++) {
        if (!this.fn.blocks[blockId]?.term) continue;
        for (const site of this.throwSites(blockId)) {
          if (!site.entries.some((entry) => covered.has(entry))) continue;
          const def = this.fn.slotDefsBefore.get(site.itemIdx)?.get(v.imm.slot);
          if (def && this.live(def)) kinds.add(def.kind);
        }
      }
      // Slots are reused with other types across a try range; only a kind
      // every covered site agrees on is the handler's.
      if (kinds.size === 1) v.kind = [...kinds][0];
    }
  }

  // Makes `def` (read by a handler's frame copy as `kind`) materialized.
  keepShadowed(def, kind, seen = new Set()) {
    if (!def || seen.has(def)) return false;
    seen.add(def);
    if (def.op === 'handler_local') {
      if (this.wantedHandlerLocal(def)) return false;
      if (!def.kind || def.kind === 'V') def.kind = kind;
      if (def.kind !== kind) return false;
      this.shadowedHandlerLocals.add(def);
      return true;
    }
    if (def.op !== 'phi' || this.live(def)) return false;
    def.kind = kind;
    this.shadowedHandlerLocals.add(def);
    for (const arg of def.args) this.keepShadowed(arg, kind, seen);
    return true;
  }

  wantedHandlerLocal(v) {
    return (this.live(v) && v.uses.length > 0) || !!this.shadowedHandlerLocals?.has(v);
  }

  // A throw inside a handler: the handler covering it copies the frame state
  // at the throw, and a slot the inner handler never read is still defined by
  // that inner handler's own handler_local (or a phi joining them). Nothing
  // in SSA uses it, so it must be kept live (with the kind its reader wants)
  // or the outer handler reads a never-written local (try-with-resources lost
  // its resource).
  markShadowedHandlerLocals() {
    if (!this.entry.handlerBlocks?.size || !this.fn.slotDefsBefore) return;
    const byBlock = new Map();
    for (const v of this.fn.values) {
      if (v.op !== 'handler_local') continue;
      if (!byBlock.has(v.block)) byBlock.set(v.block, []);
      byBlock.get(v.block).push(v);
    }
    this.shadowedHandlerLocals = new Set();
    for (let changed = true; changed;) {
      changed = false;
      for (let blockId = 0; blockId < this.fn.blocks.length; blockId++) {
        if (!this.fn.blocks[blockId]?.term) continue;
        for (const site of this.throwSites(blockId)) {
          const defs = this.fn.slotDefsBefore.get(site.itemIdx);
          if (!defs) continue;
          for (const entry of site.entries) {
            for (const local of byBlock.get(this.entry.handlerBlocks.get(entry)) || []) {
              if (!this.wantedHandlerLocal(local)) continue;
              if (this.keepShadowed(defs.get(local.imm.slot), local.kind)) changed = true;
            }
          }
        }
      }
    }
  }

  finish(node, out) {
    if (node.kind && node.kind !== 'V' && this.live(node)) {
      const repr = node.kind === 'A' ? this.reprOf(node) : null;
      if (typed(repr) && !this.world.reprSubtype(this.producedRepr(node), repr)) out.push(...this.castTo(repr));
      out.push(...this.set(node));
    }
    else if (node.kind && node.kind !== 'V') out.push(OP.drop);
  }

  // Representation an emitted node leaves on the stack; host imports, field
  // and element loads and statics produce anyref.
  producedRepr(node) {
    const plan = this.plan.get(node.id);
    if (!plan) return 'any';
    if (plan.kind === 'call') return this.calleeOf(plan.fn)?.returnRepr || 'any';
    if (plan.kind === 'virtual') return plan.resultRepr || 'any';
    if (plan.kind === 'checkcast') return this.reprOf(node.args[0]);
    if (plan.kind === 'static-get' && node.kind === 'A') return this.world.reprOfDescriptor(node.imm[2][1]);
    if (plan.kind === 'field-get' && plan.reference) return plan.fieldRepr;
    return 'any';
  }

  calleeOf(fnKey) {
    return typeof fnKey === 'string' && fnKey.startsWith('m:') ? this.world.signatureOf(fnKey.slice(2)) : null;
  }

  emitNode(node, out) {
    const op = node.op;
    this.currentNode = node;
    const arg = (i, kind) => this.use(node.args[i], kind);
    if (op === 'param' || op === 'phi' || op === 'caught_exception' || op === 'handler_local') return;
    if (op in ICONST) { out.push(OP.i32_const, ...sleb(ICONST[op])); return this.finish(node, out); }
    if (op in LCONST) { out.push(OP.i64_const, ...sleb(LCONST[op])); return this.finish(node, out); }
    if (op in FCONST) { out.push(OP.f32_const, ...f32bytes(FCONST[op])); return this.finish(node, out); }
    if (op in DCONST) { out.push(OP.f64_const, ...f64bytes(DCONST[op])); return this.finish(node, out); }
    if (op === 'aconst_null') { out.push(...NULL_REF); return this.finish(node, out); }
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
    // The opcode names its input kind; an undefined input (a slot no path
    // wrote) still needs a zero of that kind, not a null reference.
    if (CONVERT[op]) { out.push(...arg(0, op[0].toUpperCase().replace('L', 'J')), ...CONVERT[op]); return this.finish(node, out); }
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
  // Index check of a typed array: null raises NullPointerException, an
  // index outside [0, length) the bounds exception.
  typedIndexCheck(arrayCode, indexCode, lengthOps) {
    return [...indexCode, ...this.nonNull(arrayCode), ...lengthOps, OP.i32_ge_u, OP.if, 0x40,
      ...arrayCode, ...indexCode, OP.call, { fn: this.world.hostImport('err_index', [VT.anyref, VT.i32], []) }, OP.unreachable, OP.end];
  }

  // Index check against a decoded length; the failure path raises
  // NullPointerException for a null array, else the bounds exception.
  indexCheck(arrayCode, indexCode, lengthLocal) {
    return [...indexCode, OP.local_get, ...uleb(lengthLocal), OP.i32_ge_u, OP.if, 0x40,
      ...arrayCode, ...indexCode, OP.call, { fn: this.world.hostImport('err_index', [VT.anyref, VT.i32], []) }, OP.unreachable, OP.end];
  }

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
    const host = this.world.hostImport(`${store ? 'astore' : 'aload'}_${kind}`,
      store ? [VT.anyref, VT.i32, t] : [VT.anyref, VT.i32], store ? [] : [t]);
    const hostAccess = [...array, ...index, ...value, OP.call, { fn: host }];
    const spill = primitiveSpillArrayImport(this.world, op, kind);
    const closedArray = this.reprOf(node.args[0]) === 'parr' ? array
      : [...array, ...GC.ref_cast, { stype: T_PARR }];
    const storage = (base, native, handle = closedArray) => [...base, OP.i32_const, 0, OP.i32_ge_s,
      OP.if, store ? 0x40 : t, ...native, OP.else,
      ...handle, ...GC.struct_get, { type: T_PARR }, PARR.view,
      ...index, ...value, OP.call, { fn: spill }, OP.end];
    const derived = this.derived.get(node.args[0].id)?.parr;
    if (derived) {
      const L = (i) => uleb(i);
      return [...this.indexCheck(array, index, derived.len),
        ...storage([OP.local_get, ...L(derived.base)], [
          OP.local_get, ...L(derived.base), ...index, ...(shift ? [OP.i32_const, shift, OP.i32_shl] : []), OP.i32_add,
          ...value, memOp, align, 0])];
    }
    if (this.reprOf(node.args[0]) === 'parr') {
      const base = [...array, ...GC.struct_get, { type: T_PARR }, PARR.base];
      return [...this.typedIndexCheck(array, index, [...GC.struct_get, { type: T_PARR }, PARR.len]),
        ...storage(base, [...base, ...index, ...(shift ? [OP.i32_const, shift, OP.i32_shl] : []), OP.i32_add,
          ...value, memOp, align, 0])];
    }
    const pType = refNull(T_PARR);
    const p = this.temp(pType), len = this.temp([VT.i32]);
    const base = [OP.local_get, ...uleb(p), ...GC.struct_get, { type: T_PARR }, PARR.base];
    const address = [...base, ...index, ...(shift ? [OP.i32_const, shift, OP.i32_shl] : []), OP.i32_add];
    const out = [...array, ...GC.ref_test, { stype: T_PARR }, OP.if, store ? 0x40 : t,
      ...array, ...GC.ref_cast, { stype: T_PARR }, OP.local_tee, ...uleb(p),
      ...GC.struct_get, { type: T_PARR }, PARR.len, OP.local_set, ...uleb(len),
      ...this.boundsCheck(index, len),
      ...storage(base, [...address, ...value, memOp, align, 0], [OP.local_get, ...uleb(p)]),
      OP.else, ...hostAccess, OP.end];
    this.release(pType, p);
    this.release([VT.i32], len);
    return out;
  }

  // aastore's ArrayStoreException check, after the index check. `rarr`
  // pushes the array as a $rarr. Object[] stores and nulls pass in Wasm, and
  // so does the (array class, value class) pair the last check accepted;
  // anything else asks JS, which throws or caches the pair.
  storeCheck(rarr, value) {
    const cls = this.temp([VT.i32]), valueClass = this.temp([VT.i32]);
    const objectArray = this.world.objectArrayClass();
    const host = this.world.hostImport('arraystore', [VT.anyref, VT.anyref], []);
    const field = (stype, index, tag) => [...value, ...GC.ref_cast, { stype }, ...GC.struct_get, { type: stype }, index,
      ...(tag ? [OP.i32_const, ...sleb(tag), OP.i32_or] : [])];
    // Closed objects by class id, arrays by kind or class with a tag bit;
    // host values (strings, JRE objects) have no class here: -1.
    const classOf = [...value, ...GC.ref_test, { stype: T_OBJ }, OP.if, VT.i32, ...field(T_OBJ, OBJ.cls, 0),
      OP.else, ...value, ...GC.ref_test, { stype: T_PARR }, OP.if, VT.i32, ...field(T_PARR, PARR.kind, 0x40000000),
      OP.else, ...value, ...GC.ref_test, { stype: T_RARR }, OP.if, VT.i32, ...field(T_RARR, RARR.cls, 0x20000000),
      OP.else, OP.i32_const, ...sleb(-1), OP.end, OP.end, OP.end];
    const code = [...value, OP.ref_is_null, OP.i32_eqz, OP.if, 0x40,
      ...rarr, ...GC.struct_get, { type: T_RARR }, RARR.cls, OP.local_tee, ...uleb(cls),
      OP.i32_const, ...sleb(objectArray), OP.i32_ne, OP.if, 0x40,
      ...classOf, OP.local_tee, ...uleb(valueClass), OP.i32_const, ...sleb(-1), OP.i32_eq,
      OP.local_get, ...uleb(cls), OP.global_get, { global: 'storeArrayClass' }, OP.i32_ne, OP.i32_or,
      OP.local_get, ...uleb(valueClass), OP.global_get, { global: 'storeValueClass' }, OP.i32_ne, OP.i32_or,
      OP.if, 0x40, ...rarr, ...value, OP.call, { fn: host },
      OP.local_get, ...uleb(cls), OP.global_set, { global: 'storeArrayClass' },
      OP.local_get, ...uleb(valueClass), OP.global_set, { global: 'storeValueClass' },
      OP.end, OP.end, OP.end];
    this.release([VT.i32], cls);
    this.release([VT.i32], valueClass);
    return code;
  }

  referenceArray(node) {
    const store = node.op === 'aastore';
    const array = this.use(node.args[0], 'A'), index = this.use(node.args[1], 'I');
    const value = store ? this.use(node.args[2], 'A') : [];
    const asRarr = this.reprOf(node.args[0]) === 'rarr' ? array : [...array, ...GC.ref_cast, { stype: T_RARR }];
    // Emitted where the branch's own temps are live, so its temps differ.
    const check = () => (store ? this.storeCheck(asRarr, value) : []);
    const derived = this.derived.get(node.args[0].id)?.rarr;
    if (derived) {
      return [...this.indexCheck(array, index, derived.len), ...check(),
        OP.local_get, ...uleb(derived.elems), ...index, ...value, ...(store ? GC.array_set : GC.array_get), { type: T_REFS }];
    }
    if (this.reprOf(node.args[0]) === 'rarr') {
      const elems = [...GC.struct_get, { type: T_RARR }, RARR.elems];
      return [...this.typedIndexCheck(array, index, [...elems, ...GC.array_len]), ...check(),
        ...array, ...elems, ...index, ...value, ...(store ? GC.array_set : GC.array_get), { type: T_REFS }];
    }
    const eType = refNull(T_REFS);
    const e = this.temp(eType), len = this.temp([VT.i32]);
    const host = this.world.hostImport(store ? 'aastore' : 'aaload',
      store ? [VT.anyref, VT.i32, VT.anyref] : [VT.anyref, VT.i32], store ? [] : [VT.anyref]);
    const out = [...array, ...GC.ref_test, { stype: T_RARR }, OP.if, store ? 0x40 : VT.anyref,
      ...array, ...GC.ref_cast, { stype: T_RARR }, ...GC.struct_get, { type: T_RARR }, RARR.elems,
      OP.local_tee, ...uleb(e), ...GC.array_len, OP.local_set, ...uleb(len),
      ...this.boundsCheck(index, len), ...check(),
      OP.local_get, ...uleb(e), ...index, ...value, ...(store ? GC.array_set : GC.array_get), { type: T_REFS },
      OP.else, ...array, ...index, ...value, OP.call, { fn: host }, OP.end];
    this.release(eType, e);
    this.release([VT.i32], len);
    return out;
  }

  arrayLength(node) {
    const array = this.use(node.args[0], 'A');
    const derived = this.derived.get(node.args[0].id);
    const cached = derived?.parr || derived?.rarr;
    if (cached) return [...this.nonNull(array), OP.drop, OP.local_get, ...uleb(cached.len)];
    const repr = this.reprOf(node.args[0]);
    if (repr === 'parr') return [...this.nonNull(array), ...GC.struct_get, { type: T_PARR }, PARR.len];
    if (repr === 'rarr') return [...this.nonNull(array), ...GC.struct_get, { type: T_RARR }, RARR.elems, ...GC.array_len];
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
      case 'static-put': return [...this.useAs(node.args[0], plan.valueKind, this.world.reprOfDescriptor(node.imm[2][1])), ...this.staticPut(plan)];
      case 'call': return this.call(node, plan);
      case 'virtual': return this.virtualCall(node, plan);
      case 'noop': return [];
      case 'import': {
        // Generic synchronous host operation: arguments in order, one call.
        const code = [];
        plan.argKinds.forEach((kind, i) => code.push(...arg(i, kind)));
        code.push(OP.call, { fn: plan.fn });
        if (!this.parkable(plan.fn)) return code;
        const results = this.world.imports.get(plan.fn).results;
        return this.withPark(code, results.length ? KIND_OF_VT.get(results[0]) : 'V');
      }
      case 'intrinsic': return this.intrinsic(node, plan);
      case 'instanceof': return this.typeTest(node, plan, false);
      case 'checkcast': return this.typeTest(node, plan, true);
      default: throw new Unsupported(`plan ${plan.kind}`);
    }
  }

  // A host call that may ask this thread to stop: natives, host virtual
  // dispatch and monitor entry.
  parkable(fn) {
    return this.world.jspi && typeof fn === 'string' &&
      (fn.startsWith('native:') || fn.startsWith('vhost:') || fn.startsWith('vslow:') || fn === 'h:menter');
  }

  // `code` leaves the call's result (of `kind`, typed as `type`) on the
  // stack. When the host set the park flag, the result is a placeholder:
  // the suspending park import parks the thread and returns the real one.
  withPark(code, kind, type = kind === 'V' ? null : [WT[kind]], cast = []) {
    const park = this.world.parkImport(kind);
    const flag = [OP.global_get, { global: 'park' }];
    if (kind === 'V') return [...code, ...flag, OP.if, 0x40, OP.call, { fn: park }, OP.end];
    const tmp = this.temp(type);
    const out = [...code, OP.local_set, ...uleb(tmp), ...flag, OP.if, 0x40,
      OP.call, { fn: park }, ...cast, OP.local_set, ...uleb(tmp), OP.end, OP.local_get, ...uleb(tmp)];
    this.release(type, tmp);
    return out;
  }

  // Lazy class initialization: one load of the class's readiness word; only
  // the first access calls out to run the initializer.
  initCheck(target) {
    if (this.checked.has(target.className)) return [];
    this.checked.add(target.className);
    const init = this.world.hostImport('init', [VT.i32], []);
    const call = this.world.jspi
      ? this.withPark([OP.i32_const, ...sleb(target.id), OP.call, { fn: init }], 'V')
      : [OP.i32_const, ...sleb(target.id), OP.call, { fn: init }];
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

  // Reference fields are fields of the declaring class's struct; primitive
  // fields live in linear memory at the object's base.
  fieldAccess(node, plan, isPut) {
    const object = this.use(node.args[0], 'A');
    const repr = this.reprOf(node.args[0]);
    if (plan.reference) {
      const exact = this.world.reprSubtype(repr, `obj:${plan.declaring}`);
      const target = [...this.nonNull(object), ...(exact ? [] : [...GC.ref_cast, { stype: plan.structType }])];
      if (isPut) {
        return [...target, ...this.useAs(node.args[1], 'A', plan.fieldRepr),
          ...GC.struct_set, { type: plan.structType }, ...uleb(plan.structIndex)];
      }
      return [...target, ...GC.struct_get, { type: plan.structType }, ...uleb(plan.structIndex)];
    }
    const value = isPut ? this.use(node.args[1], plan.valueKind) : [];
    const closedObject = [...object, ...(repr.startsWith('obj') ? [] : [...GC.ref_cast, { stype: T_OBJ }])];
    const base = [...closedObject, ...GC.struct_get, { type: T_OBJ }, OBJ.base];
    const memarg = (align) => [align, ...uleb(plan.offset)];
    const storage = native => [...this.nonNull(object), OP.drop, ...base, OP.i32_const, 0, OP.i32_ge_s,
      OP.if, isPut ? 0x40 : WT[plan.valueKind], ...native,
      OP.else, ...closedObject, ...GC.struct_get, { type: T_OBJ }, OBJ.wrapper,
      ...value, OP.call, {fn: plan.spillFn}, OP.end];
    switch (plan.slotKind) {
      case 'i32': return storage(isPut ? [...base, ...value, OP.i32_store, ...memarg(2)] : [...base, OP.i32_load, ...memarg(2)]);
      case 'i64': return storage(isPut ? [...base, ...value, OP.i64_store, ...memarg(3)] : [...base, OP.i64_load, ...memarg(3)]);
      case 'f64':
        if (plan.valueKind === 'F') {
          return storage(isPut ? [...base, ...value, OP.f64_promote_f32, OP.f64_store, ...memarg(3)]
            : [...base, OP.f64_load, ...memarg(3), OP.f32_demote_f64]);
        }
        return storage(isPut ? [...base, ...value, OP.f64_store, ...memarg(3)] : [...base, OP.f64_load, ...memarg(3)]);
      default: throw new Unsupported(`field slot ${plan.slotKind}`);
    }
  }

  staticGet(plan) {
    return [OP.global_get, { global: plan.global }];
  }

  staticPut(plan) {
    return [OP.global_set, { global: plan.global }];
  }

  // Arguments in order, each as the callee's parameter representation
  // (anyref for host imports).
  callArgs(node, plan, fnKey = plan.fn) {
    const callee = this.calleeOf(fnKey);
    const code = [];
    plan.argKinds.forEach((kind, i) => code.push(...this.useAs(node.args[i], kind, callee ? callee.paramReprs[i] : 'any')));
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
    const receiverIsObj = this.reprOf(node.args[0]).startsWith('obj');
    // Admitted implementations share the descriptor, so they agree on the
    // result representation; host arms return anyref and are cast to it.
    const resultRepr = plan.returnKind === 'A' ? this.reprOf(node) : null;
    plan.resultRepr = resultRepr || 'any';
    const resultType = plan.returnKind === 'V' ? [0x40] : this.world.wasmType(plan.returnKind, resultRepr);
    const castResult = typed(resultRepr) ? this.castTo(resultRepr) : [];
    const cls = this.temp([VT.i32]);
    const code = [...this.nonNull(receiver), OP.drop];
    if (receiverIsObj) {
      code.push(...receiver, ...GC.struct_get, { type: T_OBJ }, OBJ.cls, OP.local_set, ...uleb(cls),
        OP.i32_const, 1, OP.if, ...resultType);
    } else {
      code.push(...receiver, ...GC.ref_test, { stype: T_OBJ }, OP.if, ...resultType,
        ...receiver, ...GC.ref_cast, { stype: T_OBJ }, ...GC.struct_get, { type: T_OBJ }, OBJ.cls, OP.local_set, ...uleb(cls));
    }
    const arms = plan.targets; // [{classIds:[...], fn}]
    let open = 0;
    for (const arm of arms) {
      for (let i = 0; i < arm.classIds.length; i++) {
        code.push(OP.local_get, ...uleb(cls), OP.i32_const, ...sleb(arm.classIds[i]), OP.i32_eq);
        if (i) code.push(OP.i32_or);
      }
      const callee = this.calleeOf(arm.fn);
      code.push(OP.if, ...resultType, ...this.callArgs(node, plan, arm.fn), OP.call, { fn: arm.fn });
      if (!callee) code.push(...castResult);
      code.push(OP.else);
      open += 1;
    }
    // A class id no arm covers, or a receiver outside closed storage with no
    // host call: the bytecode fallback (JSPI), else a loud closed-world error.
    const miss = (clsCode) => plan.fallbackFn
      ? [...this.callArgs(node, plan, plan.fallbackFn), OP.call, { fn: plan.fallbackFn }, ...castResult]
      : [...clsCode, OP.i32_const, ...sleb(plan.siteId),
        OP.call, { fn: this.world.hostImport('vmiss', [VT.i32, VT.i32], []) }, OP.unreachable];
    code.push(...miss([OP.local_get, ...uleb(cls)]));
    for (let i = 0; i < open; i++) code.push(OP.end);
    code.push(OP.else);
    if (plan.hostFn) code.push(...this.callArgs(node, plan, plan.hostFn), OP.call, { fn: plan.hostFn }, ...castResult);
    else code.push(...miss([OP.i32_const, ...sleb(-1)]));
    code.push(OP.end);
    this.release([VT.i32], cls);
    if (!this.world.jspi) return code;
    return this.withPark(code, plan.returnKind, plan.returnKind === 'V' ? null : resultType, castResult);
  }

  // instanceof / checkcast. Guest class targets test the class id in Wasm;
  // primitive array targets test the $parr kind; everything else asks JS.
  typeTest(node, plan, isCast) {
    const value = this.use(node.args[0], 'A');
    let test;
    const repr = this.reprOf(node.args[0]);
    if (plan.structType || plan.classIds) {
      // Closed objects: the struct type (class targets) or the class-id list
      // (interfaces); a miss on a class newer than the module asks JS.
      // Other values: arrays are never instances of a guest class; anything
      // else (a guest object outside closed storage) asks JS.
      const cls = this.temp([VT.i32]);
      const late = [OP.local_get, ...uleb(cls), OP.i32_const, ...sleb(plan.knownClassLimit), OP.i32_ge_u,
        OP.if, VT.i32, ...value, OP.call, { fn: plan.hostFn }, OP.else, OP.i32_const, 0, OP.end];
      let hit;
      if (plan.structType) {
        hit = [...value, ...GC.ref_test, { stype: plan.structType }];
      } else {
        hit = plan.classIds.length ? [] : [OP.i32_const, 0];
        plan.classIds.forEach((id, i) => {
          hit.push(OP.local_get, ...uleb(cls), OP.i32_const, ...sleb(id), OP.i32_eq);
          if (i) hit.push(OP.i32_or);
        });
      }
      const closed = [...value, ...GC.ref_cast, { stype: T_OBJ }, ...GC.struct_get, { type: T_OBJ }, OBJ.cls, OP.local_set, ...uleb(cls),
        ...hit, OP.if, VT.i32, OP.i32_const, 1, OP.else, ...late, OP.end];
      test = repr.startsWith('obj') ? closed
        : [...value, ...GC.ref_test, { stype: T_OBJ }, OP.if, VT.i32, ...closed, OP.else,
          ...value, ...GC.ref_test, { stype: T_PARR }, ...value, ...GC.ref_test, { stype: T_RARR }, OP.i32_or,
          OP.if, VT.i32, OP.i32_const, 0, OP.else, ...value, OP.call, { fn: plan.hostFn }, OP.end, OP.end];
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