'use strict';

/**
 * exceptionStructurer — a Tier-1 try/catch structuring layer on top of the
 * normal-control-flow `structurer`.
 *
 * The base structurer consumes a CFG that models only normal edges and requires
 * every path to end in a terminator; it knows nothing about the exception table.
 * This layer bridges the gap. Following CFR's approach it:
 *
 *   Phase A — normalises the raw exception table into *try groups*: one
 *     protected `(start_pc, end_pc)` body with N catch clauses (dropping
 *     self-handlers, shrinking body/handler overlap, grouping identical ranges).
 *
 *   Phase B — carves each group out of the normal-edges CFG by *region
 *     collapse*: it structures the try body and every handler as self-contained
 *     sub-CFGs (each region's normal exits to the join are retargeted to a
 *     synthetic empty exit block), wraps them in a new `{t:'try',...}` node, and
 *     collapses the whole group into a single super-block in the method CFG whose
 *     one successor is the join. The outer control flow then structures normally,
 *     with the try/catch appearing as one opaque node.
 *
 * v1 is deliberately conservative: anything it cannot carve cleanly (multiple
 * external exits, ranges that don't land on block boundaries, an irreducible
 * sub-region, an ambiguous join) is reported as `{ ok:false, reason }` so the
 * caller can fall back rather than emit wrong Java. Graceful bail is a feature.
 *
 * Deferred (bail on encounter): overlapping ranges of unlike types, same-target
 * row merging, try-body extension over trailing no-throw ops, multicatch, and
 * finally/synchronized. javac output rarely needs these for a single try/catch.
 */

const {
  structure,
  printTree,
  uniquifyLabels,
  buildCfgFromCode,
  reversePostorder,
  computeDominators,
  dominates,
  IrreducibleError,
  succOfTerm,
  succAllOfTerm,
} = require('./structurer');

// A sentinel returned by the internal helpers to unwind a graceful bail without
// throwing through the recursion.
class Bail {
  constructor(reason) { this.reason = reason; }
}

// ---------------------------------------------------------------------------
// Phase A — normalise the exception table into try groups.
// ---------------------------------------------------------------------------

/**
 * Turn the raw exception table into try groups. Each group is
 * `{ start_pc, end_pc, catches:[{ catch_type }] }` with catches kept in table
 * order (source catch order / JVM priority). Returns `{ groups }` or throws a
 * Bail for a shape we don't handle.
 */
function normalizeTable(exceptionTable) {
  const rows = [];
  for (const e of exceptionTable) {
    // 1. Drop a handler that lives inside its own protected range (CFR's
    //    ValidException): carving it into its own try would loop forever.
    if (e.start_pc === e.handler_pc) continue;
    let end = e.end_pc;
    // 2. Shrink the body so it can't overlap its own handler.
    if (e.start_pc < e.handler_pc && e.handler_pc <= end) end = e.handler_pc;
    if (!(end > e.start_pc)) continue; // empty after shrink — drop
    rows.push({ start_pc: e.start_pc, end_pc: end, handler_pc: e.handler_pc, catch_type: e.catch_type });
  }
  // 3. Group by identical (start_pc, end_pc) → one body, N catches in order.
  const byKey = new Map();
  const order = [];
  for (const r of rows) {
    const key = `${r.start_pc}:${r.end_pc}`;
    if (!byKey.has(key)) { byKey.set(key, { start_pc: r.start_pc, end_pc: r.end_pc, catches: [] }); order.push(key); }
    byKey.get(key).catches.push({ catch_type: r.catch_type, handler_pc: r.handler_pc });
  }
  // Each group carries an explicit `ranges` list so downstream membership tests
  // stay uniform. Rows are kept one range per group (no cross-handler merging):
  // a handler shared by several ranges is left for the caller's deferral guard
  // rather than merged, since merging re-structured methods the state-machine
  // fallback already handled correctly.
  const initialGroups = order.map((k) => {
    const g = byKey.get(k);
    return { start_pc: g.start_pc, end_pc: g.end_pc, ranges: [{ start_pc: g.start_pc, end_pc: g.end_pc }], catches: g.catches };
  });
  const groups = [];
  for (const initial of initialGroups) {
    const sharedHandlers = new Set(initial.catches.map((item) => item.handler_pc));
    const connected = groups.filter((group) => group.catches.some((item) => sharedHandlers.has(item.handler_pc)));
    if (!connected.length) {
      groups.push(initial);
      continue;
    }
    const target = connected[0];
    target.ranges.push(...initial.ranges);
    target.start_pc = Math.min(target.start_pc, initial.start_pc);
    target.end_pc = Math.max(target.end_pc, initial.end_pc);
    for (const item of initial.catches) {
      if (!target.catches.some((existing) => existing.handler_pc === item.handler_pc && existing.catch_type === item.catch_type)) {
        target.catches.push(item);
      }
    }
    for (const extra of connected.slice(1)) {
      target.ranges.push(...extra.ranges);
      target.start_pc = Math.min(target.start_pc, extra.start_pc);
      target.end_pc = Math.max(target.end_pc, extra.end_pc);
      for (const item of extra.catches) {
        if (!target.catches.some((existing) => existing.handler_pc === item.handler_pc && existing.catch_type === item.catch_type)) {
          target.catches.push(item);
        }
      }
      groups.splice(groups.indexOf(extra), 1);
    }
  }
  return { groups };
}

/** True when `pc` lies in any half-open protected range `[start_pc, end_pc)`. */
function inAnyRange(pc, ranges) {
  for (const r of ranges) if (pc >= r.start_pc && pc < r.end_pc) return true;
  return false;
}

function inLogicalTryRange(pc, group) {
  if (!group || !group.ranges || group.ranges.length < 2) return inAnyRange(pc, (group && group.ranges) || []);
  const start = Math.min(...group.ranges.map((range) => range.start_pc));
  const end = Math.max(...group.ranges.map((range) => range.end_pc));
  return pc >= start && pc < end;
}

/** Render a catch_type (class-internal name, or 0/"any"/null catch-all) as a
 * Java type. Catch-all becomes java.lang.Throwable. */
function renderCatchType(catch_type) {
  if (catch_type == null || catch_type === 0 || catch_type === 'any') return 'java.lang.Throwable';
  return String(catch_type).replace(/\//g, '.');
}

// ---------------------------------------------------------------------------
// Working CFG. During region collapse the method CFG shrinks group by group, so
// we keep a mutable view whose local ids are 0..n-1 and remember, per local
// block, the original block id (for rendering) and its start pc (for membership
// by protected range). A collapsed region becomes one synthetic super-block.
// ---------------------------------------------------------------------------

function succFromTerms(term) { return term.map(succOfTerm); }
function succAllFromTerms(term) { return term.map(succAllOfTerm); }

/** The plain CFG view the base structurer/analyses consume. */
function cfgView(work) {
  return {
    n: work.ids.length,
    entry: work.entry,
    succ: succFromTerms(work.term),
    succAll: succAllFromTerms(work.term),
    term: work.term,
  };
}

// ---------------------------------------------------------------------------
// Phase B helpers.
// ---------------------------------------------------------------------------

/**
 * Dominators computed from a synthetic root that branches to `roots` (the method
 * entry plus each handler entry). Handlers are unreachable from the method entry
 * on normal edges, so this is how a handler comes to *dominate* exactly its own
 * region while the shared join — reachable from the entry too — does not.
 */
function dominatorsFromRoots(work, roots) {
  const n = work.ids.length;
  const succ = succFromTerms(work.term).map((s) => s.slice());
  succ.push([...new Set(roots)]); // synthetic root at index n
  const root = n;
  const { rpo, rpoIndex, reachable } = reversePostorder(succ, root);
  const { idom } = computeDominators(succ, root, rpo, rpoIndex);
  return { idom, reachable };
}

/**
 * Build a self-contained sub-CFG over `memberSet` (a Set of local ids), entered
 * at `entryLocal`, whose normal exits to `mergeLocal` become a synthetic empty
 * exit block S (normal completion of the region). Structure it and remap its
 * straight/if/switch block ids back to original ids. Returns the structured
 * sub-tree, or a Bail if the region has a second external exit or is
 * irreducible.
 */
function structureRegion(work, memberSet, entryLocal, mergeLocal, ctx) {
  const members = [...memberSet].sort((a, b) => a - b);
  const subOf = new Map(); // local id -> sub id
  members.forEach((loc, i) => subOf.set(loc, i));
  const sExit = members.length; // synthetic exit id

  const remapTarget = (t) => {
    if (t == null) return null;
    if (t === mergeLocal) return sExit;
    if (subOf.has(t)) return subOf.get(t);
    return undefined; // external, and not the (single) merge -> second exit
  };

  const subTerm = [];
  for (const loc of members) {
    const t = work.term[loc];
    const mapped = remapTermTargets(t, remapTarget);
    if (mapped === undefined) return new Bail('region has a second external exit');
    subTerm.push(mapped);
  }
  subTerm.push({ kind: 'return' }); // S renders as empty (see codeLines)

  const subCfg = {
    n: members.length + 1,
    entry: subOf.get(entryLocal),
    succ: succFromTerms(subTerm),
    succAll: succAllFromTerms(subTerm),
    term: subTerm,
  };

  let res;
  try {
    res = structure(subCfg);
  } catch (err) {
    if (err instanceof IrreducibleError) return new Bail('region sub-CFG is irreducible');
    throw err;
  }

  // Map sub ids back to original ids so every straight/cond in the combined tree
  // names a real (or synthetic super-)block, keeping the global render coherent.
  const toOrig = (subId) => (subId === sExit ? ctx.emptyId : work.ids[members[subId]]);
  return remapTreeBlocks(res.tree, toOrig);
}

/** Apply a target remapper to a terminator, returning a fresh terminator with
 * remapped targets, or `undefined` if any target maps to `undefined`. */
function remapTermTargets(t, map) {
  switch (t.kind) {
    case 'return':
      return { kind: 'return' };
    case 'goto': case 'fall': {
      const tgt = map(t.target);
      if (tgt === undefined) return undefined;
      return { kind: t.kind, target: tgt };
    }
    case 'cond': {
      const taken = map(t.taken), fall = map(t.fall);
      if (taken === undefined || fall === undefined) return undefined;
      return { kind: 'cond', taken, fall };
    }
    case 'switch': {
      const cases = [];
      for (const c of t.cases) { const tg = map(c.target); if (tg === undefined) return undefined; cases.push({ key: c.key, target: tg }); }
      let dflt = t.default;
      if (dflt != null) { dflt = map(dflt); if (dflt === undefined) return undefined; }
      return { kind: 'switch', cases, default: dflt };
    }
    default:
      return undefined;
  }
}

/** Clone a statement tree, rewriting every straight/if/switch block id via `f`.
 * Labels (which name blocks/loops) are left untouched: they stay internally
 * consistent within their own sub-tree scope. */
function remapTreeBlocks(node, f) {
  if (!node) return node;
  switch (node.t) {
    case 'seq': return { t: 'seq', body: node.body.map((c) => remapTreeBlocks(c, f)) };
    case 'straight': return { t: 'straight', block: f(node.block) };
    case 'block': return { t: 'block', label: node.label, body: remapTreeBlocks(node.body, f) };
    case 'loop': return { t: 'loop', label: node.label, body: remapTreeBlocks(node.body, f) };
    case 'if': return { t: 'if', block: f(node.block), then: remapTreeBlocks(node.then, f), els: node.els ? remapTreeBlocks(node.els, f) : null };
    case 'switch': return {
      t: 'switch', block: f(node.block),
      cases: node.cases.map((c) => ({ key: c.key, body: remapTreeBlocks(c.body, f) })),
      dflt: node.dflt ? remapTreeBlocks(node.dflt, f) : null,
    };
    case 'break': case 'continue': return { ...node };
    case 'try': return {
      t: 'try', body: remapTreeBlocks(node.body, f),
      catches: node.catches.map((c) => ({
        type: c.type, varName: c.varName, carrierName: c.carrierName, body: remapTreeBlocks(c.body, f),
      })),
    };
    default: return node;
  }
}

/**
 * Collapse a carved region into one synthetic super-block whose render is the
 * pre-built try node and whose single successor is the join. Region-internal
 * blocks are removed; the method CFG is re-indexed 0..k-1.
 */
function collapseRegion(work, regionSet, tryEntryLocal, mergeLocal, superOrigId, superStartPc) {
  const kept = [];
  for (let i = 0; i < work.ids.length; i++) if (!regionSet.has(i)) kept.push(i);
  const supLocal = kept.length; // super-block goes last

  // old local id -> new local id. Anything in the region maps to the super-block
  // (only its single entry may be targeted from outside; guarded by the caller).
  const newOf = (loc) => (regionSet.has(loc) ? supLocal : kept.indexOf(loc));

  const ids = kept.map((i) => work.ids[i]);
  const startPc = kept.map((i) => work.startPc[i]);
  ids.push(superOrigId);
  startPc.push(superStartPc);

  const term = kept.map((i) => remapTermTargets(work.term[i], (t) => (t == null ? null : newOf(t))));
  term.push(mergeLocal == null ? { kind: 'return' } : { kind: 'goto', target: newOf(mergeLocal) });

  const entry = regionSet.has(work.entry) ? supLocal : kept.indexOf(work.entry);
  return { ids, entry, term, startPc };
}

// ---------------------------------------------------------------------------
// Rendering. Straight bodies render the block's instructions minus the
// control-transfer terminator (which the structurer already turned into
// if/switch/break/continue). Return/throw terminators are kept — they are real
// statements and, being terminators, are never `goto`.
// ---------------------------------------------------------------------------

const CONTROL_TRANSFER = new Set([
  'goto', 'goto_w', 'jsr', 'jsr_w', 'ret', 'tableswitch', 'lookupswitch',
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne', 'ifnull', 'ifnonnull',
]);

function insnOp(item) {
  const i = item && item.instruction;
  return !i ? '' : (typeof i === 'string' ? i : i.op || '');
}

// Instructions that provably cannot raise a catchable exception: constants,
// local loads/stores, stack shuffles, non-trapping arithmetic/conversions,
// comparisons, branches, switches, method returns, iinc, nop. Everything else —
// field/array access, invokes, allocation, checkcast, monitor ops, athrow,
// div/rem, jsr/ret, ldc (class-constant resolution) — is treated as throwing.
// Used to decide whether a try body that overshoots its end_pc is harmless.
const NONTHROWING = new Set([
  'nop', 'aconst_null',
  'iconst_m1', 'iconst_0', 'iconst_1', 'iconst_2', 'iconst_3', 'iconst_4', 'iconst_5',
  'lconst_0', 'lconst_1', 'fconst_0', 'fconst_1', 'fconst_2', 'dconst_0', 'dconst_1',
  'bipush', 'sipush',
  'iload', 'lload', 'fload', 'dload', 'aload',
  'iload_0', 'iload_1', 'iload_2', 'iload_3', 'lload_0', 'lload_1', 'lload_2', 'lload_3',
  'fload_0', 'fload_1', 'fload_2', 'fload_3', 'dload_0', 'dload_1', 'dload_2', 'dload_3',
  'aload_0', 'aload_1', 'aload_2', 'aload_3',
  'istore', 'lstore', 'fstore', 'dstore', 'astore',
  'istore_0', 'istore_1', 'istore_2', 'istore_3', 'lstore_0', 'lstore_1', 'lstore_2', 'lstore_3',
  'fstore_0', 'fstore_1', 'fstore_2', 'fstore_3', 'dstore_0', 'dstore_1', 'dstore_2', 'dstore_3',
  'astore_0', 'astore_1', 'astore_2', 'astore_3',
  'pop', 'pop2', 'dup', 'dup_x1', 'dup_x2', 'dup2', 'dup2_x1', 'dup2_x2', 'swap',
  'iadd', 'ladd', 'fadd', 'dadd', 'isub', 'lsub', 'fsub', 'dsub',
  'imul', 'lmul', 'fmul', 'dmul', 'fdiv', 'ddiv', 'frem', 'drem',
  'ineg', 'lneg', 'fneg', 'dneg',
  'ishl', 'lshl', 'ishr', 'lshr', 'iushr', 'lushr',
  'iand', 'land', 'ior', 'lor', 'ixor', 'lxor', 'iinc',
  'i2l', 'i2f', 'i2d', 'l2i', 'l2f', 'l2d', 'f2i', 'f2l', 'f2d', 'd2i', 'd2l', 'd2f', 'i2b', 'i2c', 'i2s',
  'lcmp', 'fcmpl', 'fcmpg', 'dcmpl', 'dcmpg',
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne', 'ifnull', 'ifnonnull',
  'goto', 'goto_w', 'tableswitch', 'lookupswitch',
  'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'return',
]);

function canThrow(op) { return !NONTHROWING.has(op); }

/** Blocks reachable from the method entry over normal (non-exception) edges. */
function reachableFrom(cfg) {
  const seen = new Array(cfg.n).fill(false);
  const stack = [cfg.entry];
  seen[cfg.entry] = true;
  while (stack.length) {
    const b = stack.pop();
    for (const t of cfg.succ[b]) if (t != null && !seen[t]) { seen[t] = true; stack.push(t); }
  }
  return seen;
}

/** Build the pluggable render for a method's blocks, keyed by original id. */
function makeRender(codeItems, origBlocks) {
  const codeLines = (origId) => {
    const b = origBlocks[origId];
    if (!b) return []; // synthetic empty exit / super-block placeholder
    const lines = [];
    for (let k = 0; k < b.insns.length; k++) {
      const op = insnOp(codeItems[b.insns[k]]);
      const isLast = k === b.insns.length - 1;
      if (isLast && CONTROL_TRANSFER.has(op)) continue; // consumed by structuring
      lines.push(`${op};`);
    }
    return lines;
  };
  return { straight: codeLines, cond: (id) => `c${id}`, switchValue: (id) => `sel${id}` };
}

// ---------------------------------------------------------------------------
// Substitution: replace each super-block straight with its pre-built try node
// (recursively, so nested try/catch resolves). After this the tree is
// self-contained and prints with the plain per-block render.
// ---------------------------------------------------------------------------

function substituteSupers(node, overrides) {
  if (!node) return node;
  if (node.t === 'straight' && overrides.has(node.block)) {
    return substituteSupers(overrides.get(node.block), overrides);
  }
  switch (node.t) {
    case 'seq': return { t: 'seq', body: node.body.map((c) => substituteSupers(c, overrides)) };
    case 'block': return { t: 'block', label: node.label, body: substituteSupers(node.body, overrides) };
    case 'loop': return { t: 'loop', label: node.label, body: substituteSupers(node.body, overrides) };
    case 'if': return { t: 'if', block: node.block, then: substituteSupers(node.then, overrides), els: node.els ? substituteSupers(node.els, overrides) : null };
    case 'switch': return {
      t: 'switch', block: node.block,
      cases: node.cases.map((c) => ({ key: c.key, body: substituteSupers(c.body, overrides) })),
      dflt: node.dflt ? substituteSupers(node.dflt, overrides) : null,
    };
    case 'try': return {
      t: 'try', body: substituteSupers(node.body, overrides),
      catches: node.catches.map((c) => ({
        type: c.type, varName: c.varName, carrierName: c.carrierName, body: substituteSupers(c.body, overrides),
      })),
    };
    default: return node;
  }
}

// ---------------------------------------------------------------------------
// Top level.
// ---------------------------------------------------------------------------

/**
 * Structure one method (Krakatau-style codeItems + its exception table) into a
 * goto-free statement tree with try/catch. Returns `{ ok:true, tree, render }`
 * (render is the block printer for `printTree`), or `{ ok:false, reason }` when
 * the method is outside v1's scope and the caller should fall back.
 */
function structureMethod(codeItems, exceptionTable) {
  const res = structureMethodImpl(codeItems, exceptionTable);
  // Trees composed from several independent structure() calls (a try body nested
  // in the method) can reuse the same L<blockId> label at different nesting
  // depths, which is a Java compile error. Rename to globally-unique labels
  // while preserving nearest-match break/continue resolution.
  if (res && res.ok && res.tree) uniquifyLabels(res.tree);
  return res;
}

function structureMethodImpl(codeItems, exceptionTable) {
  const methodCfg = buildCfgFromCode(codeItems);
  if (!methodCfg) return { ok: true, tree: { t: 'seq', body: [] }, render: makeRender(codeItems, []) };
  const origBlocks = methodCfg.blocks;
  const render = makeRender(codeItems, origBlocks);

  // No exception table: the base structurer handles everything.
  if (!exceptionTable || exceptionTable.length === 0) {
    try {
      const { tree } = structure(methodCfg);
      return { ok: true, tree, render };
    } catch (err) {
      if (err instanceof IrreducibleError) return { ok: false, reason: `irreducible: ${err.message}` };
      return { ok: false, reason: `internal: ${err.message}` };
    }
  }

  try {
    return structureWithExceptions(codeItems, exceptionTable, methodCfg, render);
  } catch (err) {
    if (err instanceof IrreducibleError) return { ok: false, reason: `irreducible: ${err.message}` };
    return { ok: false, reason: `internal: ${err.message}` };
  }
}

function structureWithExceptions(codeItems, exceptionTable, methodCfg, render) {
  const { groups } = normalizeTable(exceptionTable);
  if (groups.length === 0) {
    const { tree } = structure(methodCfg);
    return { ok: true, tree, render };
  }

  const origBlocks = methodCfg.blocks;
  const pcOf = (b) => codeItems[b.insns[0]].pc;

  // A protected range whose end_pc falls mid-block pulls the whole straddling
  // block into the try body (membership is by block leader, not by end_pc). The
  // trailing instructions at pc >= end_pc — javac's success-continuation tail —
  // are then rendered inside try{} even though the JVM does not protect them. If
  // that tail is pure no-throw glue (return/goto/iinc/const/load/store/arith) the
  // try is merely drawn a touch large with no observable difference. But if the
  // tail contains an instruction that can throw a catchable exception, leaving it
  // inside try{} is WRONG Java: the throw would be caught (or routed to the wrong
  // nested handler) instead of propagating. Bail on exactly that case — but only
  // for blocks reachable on normal edges, since obfuscators leave unreachable
  // athrow blocks whose leader sits inside a protected range and which the base
  // structurer correctly omits from the output anyway.
  const reachable = reachableFrom(methodCfg);
  for (const g of groups) {
    for (const b of origBlocks) {
      if (!reachable[b.id]) continue;
      const lead = pcOf(b);
      if (!inAnyRange(lead, g.ranges)) continue; // not a try-body block
      for (const ii of b.insns) {
        const pc = codeItems[ii].pc;
        if (inAnyRange(pc, g.ranges)) continue; // still inside a protected range
        if (canThrow(insnOp(codeItems[ii]))) {
          return { ok: false, reason: 'protected range ends mid-block over a throwing instruction (deferred: exception-boundary block split)' };
        }
      }
    }
  }

  // Initial working CFG: local ids == original ids.
  let work = {
    ids: origBlocks.map((b) => b.id),
    entry: methodCfg.entry,
    term: methodCfg.term.map((t) => ({ ...t })),
    startPc: origBlocks.map((b) => pcOf(b)),
  };

  const overrides = new Map(); // synthetic id -> try node (or empty node)
  let nextSynthetic = origBlocks.length;
  const allocId = () => nextSynthetic++;
  const emptyId = allocId();
  overrides.set(emptyId, { t: 'seq', body: [] }); // region normal-completion exit

  // Innermost first: smallest protected range, then earliest start. Collapsing a
  // nested group turns it into a super-block that the enclosing group then picks
  // up by start pc, so nesting falls out naturally.
  const ordered = groups.slice().sort((a, b) =>
    (a.end_pc - a.start_pc) - (b.end_pc - b.start_pc) || a.start_pc - b.start_pc);

  for (const g of ordered) {
    const bail = processGroup(work, g, { overrides, allocId, emptyId }, (w) => { work = w; });
    if (bail instanceof Bail) return { ok: false, reason: bail.reason };
  }

  let res;
  try {
    res = structure(cfgView(work));
  } catch (err) {
    if (err instanceof IrreducibleError) return { ok: false, reason: `irreducible: ${err.message}` };
    throw err;
  }
  // Names carried in `work.ids` are original/synthetic ids already.
  let tree = remapTreeBlocks(res.tree, (localId) => work.ids[localId]);
  tree = substituteSupers(tree, overrides);
  return { ok: true, tree, render };
}

/** Carve and collapse one try group in `work`. On success calls `commit(work')`
 * with the collapsed CFG and returns undefined; on an out-of-scope shape returns
 * a Bail. */
function processGroup(work, group, ctx, commit) {
  const n = work.ids.length;
  const localOfStartPc = (pc) => {
    for (let i = 0; i < n; i++) if (work.startPc[i] === pc) return i;
    return -1;
  };

  // Boundaries must land on block leaders: the try entry and each handler entry.
  const tryEntry = localOfStartPc(group.start_pc);
  if (tryEntry < 0) return new Bail('try start does not land on a block boundary');
  const handlerLocals = [];
  for (const c of group.catches) {
    const h = localOfStartPc(c.handler_pc);
    if (h < 0) return new Bail('handler start does not land on a block boundary');
    handlerLocals.push(h);
  }

  // TRY = blocks whose start offset falls inside any of the group's protected
  // ranges (one after same-target row merging is the common case; several when
  // the compiler split one logical try body across table rows).
  const tryset = new Set();
  for (let i = 0; i < n; i++) if (inLogicalTryRange(work.startPc[i], group)) tryset.add(i);
  if (!tryset.has(tryEntry)) return new Bail('try entry is outside its own range');

  // Handler regions: blocks a handler entry dominates (synthetic root over the
  // method entry + all handler entries), minus the try body.
  const { idom, reachable } = dominatorsFromRoots(work, [work.entry, ...handlerLocals]);
  const handlerSets = [];
  const inSomeHandler = new Set();
  for (const h of handlerLocals) {
    const hs = new Set();
    for (let b = 0; b < n; b++) {
      if (!reachable[b] || tryset.has(b)) continue;
      if (dominates(idom, h, b)) {
        if (inSomeHandler.has(b)) return new Bail('overlapping handler regions');
        inSomeHandler.add(b);
        hs.add(b);
      }
    }
    if (!hs.has(h)) return new Bail('handler entry unreachable / not self-dominating');
    handlerSets.push(hs);
  }

  // Whole region and its single external exit (the merge/join).
  const region = new Set([...tryset, ...inSomeHandler]);
  const externals = new Set();
  for (const b of region) for (const t of succOfTerm(work.term[b])) if (t != null && !region.has(t)) externals.add(t);
  if (externals.size > 1) return new Bail('try/catch has more than one external exit');
  const mergeLocal = externals.size === 1 ? [...externals][0] : null;

  // Only the try entry may be targeted from outside the region.
  for (let b = 0; b < n; b++) {
    if (region.has(b)) continue;
    for (const t of succOfTerm(work.term[b])) if (t != null && region.has(t) && t !== tryEntry) {
      return new Bail(`region entered other than at its try/handler entry: ${work.startPc[b]} -> ${work.startPc[t]} (entry ${group.start_pc})`);
    }
  }

  // Structure the try body and each handler as exit-to-merge sub-regions.
  const tryTree = structureRegion(work, tryset, tryEntry, mergeLocal, ctx);
  if (tryTree instanceof Bail) return tryTree;
  const catches = [];
  for (let ci = 0; ci < group.catches.length; ci++) {
    const hTree = structureRegion(work, handlerSets[ci], handlerLocals[ci], mergeLocal, ctx);
    if (hTree instanceof Bail) return hTree;
    catches.push({
      type: renderCatchType(group.catches[ci].catch_type),
      varName: 'decompiledCaughtParameter',
      carrierName: 'decompiledCaughtException',
      body: hTree,
    });
  }

  const tryNode = { t: 'try', body: tryTree, catches };
  const superId = ctx.allocId();
  ctx.overrides.set(superId, tryNode);
  commit(collapseRegion(work, region, tryEntry, mergeLocal, superId, group.start_pc));
  return undefined;
}

module.exports = {
  structureMethod,
  // exposed for tests
  normalizeTable,
  renderCatchType,
};
