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
  uniquifyCatchParameters,
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

// Label name for the block that wraps each structured try/handler sub-region so
// its exit sinks can `break` out explicitly. Several wrappers may nest (inner
// try inside an outer one); break resolves to the nearest frame and
// uniquifyLabels renames them apart afterwards.
const REGION_EXIT_LABEL = 'RegionExit';

// ---------------------------------------------------------------------------
// Phase A — normalise the exception table into try groups.
// ---------------------------------------------------------------------------

/**
 * Turn the raw exception table into try groups. Each group is
 * `{ start_pc, end_pc, catches:[{ catch_type }] }` with catches kept in table
 * order (source catch order / JVM priority). Returns `{ groups }` or throws a
 * Bail for a shape we don't handle.
 */
function normalizeTable(exceptionTable, syncHandlers) {
  const isSyncHandler = (handlerPc) => !!(syncHandlers && syncHandlers.has(handlerPc));
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
  // A synchronized region's monitor-release handler (recognized upstream and
  // recorded in syncHandlers) is never a sibling catch of a real try: the
  // `synchronized` block is always its own nested region. When the same body
  // range is protected by both a sync handler and a real catch (a
  // `try { synchronized (x) { … } } catch (E)`), grouping by (start_pc, end_pc)
  // below would fuse them into one multi-catch try — emitting an invalid
  // `catch (Throwable) … catch (E)` pair instead of a nested block. Split the
  // sync-handler rows out into their own per-handler group up front so the two
  // structure as sibling groups and nest by protected-range size.
  const syncGroups = [];
  if (syncHandlers && syncHandlers.size) {
    const byHandler = new Map();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!isSyncHandler(rows[i].handler_pc)) continue;
      const r = rows.splice(i, 1)[0];
      if (!byHandler.has(r.handler_pc)) byHandler.set(r.handler_pc, []);
      byHandler.get(r.handler_pc).push(r);
    }
    for (const [handlerPc, hrows] of byHandler) {
      const start_pc = Math.min(...hrows.map((r) => r.start_pc));
      const end_pc = Math.max(...hrows.map((r) => r.end_pc));
      syncGroups.push({
        start_pc, end_pc,
        ranges: hrows.map((r) => ({ start_pc: r.start_pc, end_pc: r.end_pc })),
        catches: [{ catch_type: hrows[0].catch_type, handler_pc: handlerPc }],
      });
    }
  }
  // 3. Group by identical (start_pc, end_pc) → one body, N catches in order.
  const byKey = new Map();
  const order = [];
  for (const r of rows) {
    const key = `${r.start_pc}:${r.end_pc}`;
    if (!byKey.has(key)) { byKey.set(key, { start_pc: r.start_pc, end_pc: r.end_pc, catches: [] }); order.push(key); }
    const catches = byKey.get(key).catches;
    const sharedHandler = catches.find((item) => item.handler_pc === r.handler_pc);
    if (sharedHandler) {
      const types = Array.isArray(sharedHandler.catch_type)
        ? sharedHandler.catch_type
        : [sharedHandler.catch_type];
      if (!types.includes(r.catch_type)) types.push(r.catch_type);
      sharedHandler.catch_type = types;
    } else {
      catches.push({ catch_type: r.catch_type, handler_pc: r.handler_pc });
    }
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
  const mergeSameHandlerCatches = (group) => {
    const byHandler = new Map();
    const catches = [];
    for (const item of group.catches || []) {
      let merged = byHandler.get(item.handler_pc);
      if (!merged) {
        merged = { handler_pc: item.handler_pc, catchTypes: [] };
        byHandler.set(item.handler_pc, merged);
        catches.push(merged);
      }
      const types = Array.isArray(item.catch_type) ? item.catch_type : [item.catch_type];
      for (const type of types) if (!merged.catchTypes.includes(type)) merged.catchTypes.push(type);
    }
    group.catches = catches.map((item) => ({
      handler_pc: item.handler_pc,
      catch_type: item.catchTypes.length === 1 ? item.catchTypes[0] : item.catchTypes,
    }));
    return group;
  };
  return { groups: [...groups, ...syncGroups].map(mergeSameHandlerCatches) };
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
  return renderCatchTypes(catch_type).join(' | ');
}

function renderCatchTypes(catch_type) {
  if (Array.isArray(catch_type)) return catch_type.flatMap(renderCatchTypes);
  if (catch_type == null || catch_type === 0 || catch_type === 'any') return ['java.lang.Throwable'];
  return [String(catch_type).replace(/\//g, '.')];
}

// JRE ancestry for the throwable types these class files actually catch. Used
// to detect a later sibling catch that javac rejects because an earlier one
// already covers it. Unknown (application) types have no known ancestors:
// treating them as unrelated only risks leaving the javac error in place,
// never a wrong wrap.
const CATCH_TYPE_ANCESTORS = new Map([
  ['java.lang.Exception', ['java.lang.Throwable']],
  ['java.lang.Error', ['java.lang.Throwable']],
  ['java.lang.RuntimeException', ['java.lang.Exception', 'java.lang.Throwable']],
  ['java.io.IOException', ['java.lang.Exception', 'java.lang.Throwable']],
  ['java.io.InterruptedIOException', ['java.io.IOException', 'java.lang.Exception', 'java.lang.Throwable']],
  ['java.lang.InterruptedException', ['java.lang.Exception', 'java.lang.Throwable']],
  ['java.lang.SecurityException', ['java.lang.RuntimeException', 'java.lang.Exception', 'java.lang.Throwable']],
  ['java.lang.IllegalArgumentException', ['java.lang.RuntimeException', 'java.lang.Exception', 'java.lang.Throwable']],
  ['java.lang.IllegalStateException', ['java.lang.RuntimeException', 'java.lang.Exception', 'java.lang.Throwable']],
  ['java.lang.NullPointerException', ['java.lang.RuntimeException', 'java.lang.Exception', 'java.lang.Throwable']],
  ['java.lang.ClassCastException', ['java.lang.RuntimeException', 'java.lang.Exception', 'java.lang.Throwable']],
  ['java.lang.ArithmeticException', ['java.lang.RuntimeException', 'java.lang.Exception', 'java.lang.Throwable']],
  ['java.lang.IndexOutOfBoundsException', ['java.lang.RuntimeException', 'java.lang.Exception', 'java.lang.Throwable']],
  ['java.lang.ArrayIndexOutOfBoundsException', ['java.lang.IndexOutOfBoundsException', 'java.lang.RuntimeException', 'java.lang.Exception', 'java.lang.Throwable']],
]);

/** True when a `catch (earlier)` clause makes a following `catch (later)`
 * unreachable for javac: same type, catch-all Throwable, or a known JRE
 * ancestor/descendant pair. */
function catchTypesSubsumes(earlierTypes, laterTypes) {
  return earlierTypes.some((earlierType) => laterTypes.some((laterType) => {
    if (earlierType === laterType) return true;
    if (earlierType === 'java.lang.Throwable') return true;
    return (CATCH_TYPE_ANCESTORS.get(laterType) || []).includes(earlierType);
  }));
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
/** Blocks reachable over normal edges from any of `roots` (BFS, no dominators). */
function livenessFrom(work, roots) {
  const succ = succFromTerms(work.term);
  const seen = new Array(work.ids.length).fill(false);
  const stack = [];
  for (const r of roots) if (r != null && r >= 0 && !seen[r]) { seen[r] = true; stack.push(r); }
  while (stack.length) {
    const b = stack.pop();
    for (const t of succ[b]) if (t != null && !seen[t]) { seen[t] = true; stack.push(t); }
  }
  return seen;
}

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
function structureRegion(work, memberSet, entryLocal, externalToRenderId, ctx) {
  const members = [...memberSet].sort((a, b) => a - b);
  const subOf = new Map(); // local id -> sub id
  members.forEach((loc, i) => subOf.set(loc, i));

  // One synthetic exit sink per external target of the whole region. A region
  // with several external exits (e.g. a synchronized block in a loop that both
  // `continue`s and falls through) gets one sink per exit; each sink renders the
  // selector assignment `sel = <index>;`, and the collapsed super-block dispatches
  // on `sel` in the outer CFG. A single-exit region keeps its old shape: one sink
  // that renders empty (the region's normal completion).
  const externals = [...externalToRenderId.keys()];
  const sinkOf = new Map(); // external local -> sub sink id
  externals.forEach((ext, i) => sinkOf.set(ext, members.length + i));

  const remapTarget = (t) => {
    if (t == null) return null;
    if (subOf.has(t)) return subOf.get(t);
    if (sinkOf.has(t)) return sinkOf.get(t);
    return undefined; // external the region-external analysis did not enumerate
  };

  const subTerm = [];
  for (const loc of members) {
    const t = work.term[loc];
    let unenumeratedTarget;
    const mapped = remapTermTargets(t, (target) => {
      const result = remapTarget(target);
      if (result === undefined) unenumeratedTarget = target;
      return result;
    });
    if (mapped === undefined) {
      const sourcePc = work.startPc[loc];
      const targetPc = unenumeratedTarget == null ? unenumeratedTarget : work.startPc[unenumeratedTarget];
      const knownExternalPcs = externals.map((external) => work.startPc[external]).join(', ');
      return new Bail(`region has an unenumerated external exit: ${sourcePc} -> ${targetPc} (targetInSubregion=${memberSet.has(unenumeratedTarget)}, knownExternalPcs=[${knownExternalPcs}])`);
    }
    subTerm.push(mapped);
  }
  for (let i = 0; i < externals.length; i++) subTerm.push({ kind: 'return' }); // sinks render via toOrig

  let structuredTerms = subTerm;
  let origins = [...Array(subTerm.length).keys()];
  const makeCfg = () => ({
    n: structuredTerms.length,
    entry: subOf.get(entryLocal),
    succ: succFromTerms(structuredTerms),
    succAll: succAllFromTerms(structuredTerms),
    term: structuredTerms,
  });

  let res;
  try {
    res = structure(makeCfg());
  } catch (err) {
    if (err instanceof IrreducibleError) {
      const split = splitIrreducibleTerms(structuredTerms, subOf.get(entryLocal));
      if (!split) {
        const [from, to] = String((err.edges || [])[0] || '').split('->').map(Number);
        if (!Number.isInteger(from) || !Number.isInteger(to) || !structuredTerms[to]) {
          return new Bail(`region sub-CFG is irreducible: ${err.message}`);
        }
        // Tail-duplicate the retreating edge's target for this predecessor. The
        // clone executes the identical block and retains its original outgoing
        // edges, but the awkward join is no longer a retreating edge.
        const clone = structuredTerms.length;
        structuredTerms.push(remapTermTargets(structuredTerms[to], (target) => target));
        origins.push(origins[to]);
        structuredTerms[from] = remapTermTargets(structuredTerms[from], (target) =>
          target === to ? clone : target);
      } else {
        structuredTerms = split.terms;
        origins = split.origins;
      }
      try {
        res = structure(makeCfg());
      } catch (retryError) {
        if (retryError instanceof IrreducibleError) return new Bail(`region sub-CFG remains irreducible after controlled splitting: ${retryError.message}`);
        throw retryError;
      }
    }
    else throw err;
  }

  // Map sub ids back to original/synthetic ids so every straight/cond in the
  // combined tree names a real (or synthetic super-/sink) block.
  const toOrig = (subId) => {
    const originalSubId = origins[subId];
    if (originalSubId < members.length) return work.ids[members[originalSubId]];
    return externalToRenderId.get(externals[originalSubId - members.length]);
  };
  return remapTreeBlocks(res.tree, toOrig);
}

// Controlled node splitting for an induced exception sub-CFG. The whole method
// has already been normalized, but carving handler edges can expose a
// multi-entry SCC inside a try body. Clone the SCC once per secondary entry and
// redirect only predecessors outside the SCC; cloned nodes render the same
// bytecode blocks as their originals.
function splitIrreducibleTerms(inputTerms, entry) {
  let terms = inputTerms.map((term) => ({ ...term }));
  let origins = [...Array(terms.length).keys()];
  for (let round = 0; round < 64; round++) {
    const succ = succFromTerms(terms);
    const n = terms.length;
    const index = new Array(n).fill(-1), low = new Array(n).fill(0);
    const stack = [], onStack = new Array(n).fill(false), components = [];
    let nextIndex = 0;
    const visit = (v) => {
      index[v] = low[v] = nextIndex++;
      stack.push(v); onStack[v] = true;
      for (const w of succ[v]) {
        if (index[w] < 0) { visit(w); low[v] = Math.min(low[v], low[w]); }
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      }
      if (low[v] === index[v]) {
        const component = [];
        for (;;) { const w = stack.pop(); onStack[w] = false; component.push(w); if (w === v) break; }
        components.push(component);
      }
    };
    for (let v = 0; v < n; v++) if (index[v] < 0) visit(v);

    let candidate = null;
    for (const component of components) {
      if (component.length === 1 && !succ[component[0]].includes(component[0])) continue;
      const inside = new Set(component), entries = [];
      for (const node of component) {
        let externalPreds = node === entry ? 1 : 0;
        for (let pred = 0; pred < n; pred++) if (!inside.has(pred) && succ[pred].includes(node)) externalPreds++;
        if (externalPreds) entries.push({ node, externalPreds });
      }
      if (entries.length > 1) { candidate = { component, inside, entries }; break; }
    }
    if (!candidate) return round ? { terms, origins } : null;
    const primary = candidate.entries.find((item) => item.node === entry)
      || candidate.entries.slice().sort((a, b) => b.externalPreds - a.externalPreds)[0];
    const secondary = candidate.entries.find((item) => item !== primary);
    const cloneOf = new Map();
    for (const node of candidate.component) {
      cloneOf.set(node, terms.length);
      terms.push(null);
      origins.push(origins[node]);
    }
    for (const node of candidate.component) {
      terms[cloneOf.get(node)] = remapTermTargets(terms[node], (target) =>
        candidate.inside.has(target) ? cloneOf.get(target) : target);
    }
    for (let pred = 0; pred < n; pred++) {
      if (candidate.inside.has(pred)) continue;
      terms[pred] = remapTermTargets(terms[pred], (target) =>
        target === secondary.node ? cloneOf.get(target) : target);
    }
  }
  return { terms, origins };
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
        types: c.types, varName: c.varName, carrierName: c.carrierName, body: remapTreeBlocks(c.body, f),
      })),
    };
    case 'synchronized': return {
      t: 'synchronized', lockLocal: node.lockLocal, lockPc: node.lockPc,
      body: remapTreeBlocks(node.body, f),
    };
    default: return node;
  }
}

/**
 * Collapse a carved region into one synthetic super-block whose render is the
 * pre-built try node and whose single successor is the join. Region-internal
 * blocks are removed; the method CFG is re-indexed 0..k-1.
 */
function collapseRegion(work, regionSet, superOrigId, superStartPc, exits, ctx) {
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

  // The super-block renders the collapsed try/synchronized node (via
  // substituteSupers) and then transfers to the region's exit(s):
  //   - 0 exits: the region always returns/throws — the super-block returns.
  //   - 1 exit: a plain goto to the join.
  //   - k exits: a chain of k-1 synthetic `if (sel == j) goto E_j` dispatch
  //     blocks; the region body set `sel` before leaving. These render via the
  //     synthetic-cond map so the outer structurer sees a normal if/else chain.
  if (exits.length === 0) {
    term.push({ kind: 'return' });
  } else if (exits.length === 1) {
    term.push({ kind: 'goto', target: newOf(exits[0].external) });
  } else {
    const dispatchBase = supLocal + 1;
    term.push({ kind: 'goto', target: dispatchBase });
    for (let j = 0; j < exits.length - 1; j++) {
      const fall = j === exits.length - 2
        ? newOf(exits[exits.length - 1].external)
        : dispatchBase + j + 1;
      term.push({ kind: 'cond', taken: newOf(exits[j].external), fall });
      const dispatchId = ctx.allocId();
      ids.push(dispatchId);
      startPc.push(superStartPc); // co-located with the region for enclosing-range membership
      ctx.synthetic.set(dispatchId, { cond: `${exits.selectorName} == ${exits[j].index}` });
    }
  }

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
  const render = {
    straight: (origId) => {
      const syn = render.synthetic && render.synthetic.get(origId);
      if (syn && syn.straight) return syn.straight;
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
    },
    cond: (id) => {
      const syn = render.synthetic && render.synthetic.get(id);
      if (syn && syn.cond) return syn.cond;
      return `c${id}`;
    },
    switchValue: (id) => `sel${id}`,
    syncLock: (local) => `lv${local}`,
    synthetic: null,
  };
  return render;
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
        types: c.types, varName: c.varName, carrierName: c.carrierName, body: substituteSupers(c.body, overrides),
      })),
    };
    case 'synchronized': return {
      t: 'synchronized', lockLocal: node.lockLocal, lockPc: node.lockPc,
      body: substituteSupers(node.body, overrides),
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
function structureMethod(codeItems, exceptionTable, opts = {}) {
  const res = structureMethodImpl(codeItems, exceptionTable, opts);
  // Trees composed from several independent structure() calls (a try body nested
  // in the method) can reuse the same L<blockId> label at different nesting
  // depths, which is a Java compile error. Rename to globally-unique labels
  // while preserving nearest-match break/continue resolution.
  if (res && res.ok && res.tree) { uniquifyLabels(res.tree); uniquifyCatchParameters(res.tree); }
  return res;
}

function structureMethodImpl(codeItems, exceptionTable, opts = {}) {
  // Force block leaders at every exception-region boundary pc so a try/handler
  // body always begins on a block boundary. Without this, a try `start_pc` that
  // is not a branch target sits mid-block and processGroup bails with "try start
  // does not land on a block boundary", degrading the whole method to the
  // comment-dropping state-machine fallback.
  const boundaryPcs = [];
  for (const e of (exceptionTable || [])) {
    if (e.start_pc != null) boundaryPcs.push(e.start_pc);
    if (e.end_pc != null) boundaryPcs.push(e.end_pc);
    if (e.handler_pc != null) boundaryPcs.push(e.handler_pc);
  }
  const methodCfg = buildCfgFromCode(codeItems, [], boundaryPcs);
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
    return structureWithExceptions(codeItems, exceptionTable, methodCfg, render, opts);
  } catch (err) {
    if (err instanceof IrreducibleError) return { ok: false, reason: `irreducible: ${err.message}` };
    return { ok: false, reason: `internal: ${err.message}` };
  }
}

function structureWithExceptions(codeItems, exceptionTable, methodCfg, render, opts = {}) {
  const { groups } = normalizeTable(exceptionTable, opts.syncHandlers || null);
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

  // Synthetic-block render text (straight lines / cond expression) for the
  // selector sinks and dispatch blocks a multi-exit region introduces. The base
  // structurer has no bytecode for these ids; the caller's render composes this
  // map over its own so the selector assignments and `sel == j` tests print.
  const synthetic = new Map();
  render.synthetic = synthetic; // exposed for the exceptionStructurer's own printTree
  const selectorDecls = [];
  let nextSelector = 0;
  const allocSelector = () => {
    const name = `decompiledRegionSelector${nextSelector++}`;
    selectorDecls.push(name);
    return name;
  };

  // Every handler entry pc across the whole table. A block can be reachable only
  // through a *different* group's catch handler that has not collapsed yet (e.g.
  // code after a try/catch whose try body always returns — reachable solely via
  // the catch's fall-through). Per-group reachability would wrongly call such a
  // block dead and empty its try body; method-wide handler liveness fixes that.
  const allHandlerPcs = new Set();
  for (const g of groups) for (const c of g.catches) allHandlerPcs.add(c.handler_pc);

  // True when a working-CFG block provably cannot raise a catchable exception.
  // Synthetic super-blocks (collapsed inner try/catch) are conservatively
  // treated as throwing.
  const isNoThrowBlock = (w, local) => {
    const b = origBlocks[w.ids[local]];
    if (!b) return false;
    for (const ii of b.insns) if (canThrow(insnOp(codeItems[ii]))) return false;
    return true;
  };

  // Innermost first: smallest protected range. For equal-size regions, process
  // the later bytecode range first: javac duplicates finally bodies after the
  // primary try/catch, and an earlier handler can normally flow into that later
  // copy. Collapsing the later region first keeps its entry from being absorbed
  // as ordinary handler continuation before it has been structured.
  const ordered = groups.slice().sort((a, b) =>
    (a.end_pc - a.start_pc) - (b.end_pc - b.start_pc) || b.start_pc - a.start_pc);

  for (const g of ordered) {
    const bail = processGroup(work, g, {
      overrides, allocId, emptyId, isNoThrowBlock, allHandlerPcs,
      synthetic, allocSelector,
      syncHandlers: opts.syncHandlers || null,
    }, (w) => { work = w; });
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
  return { ok: true, tree, render, synthetic, selectorDecls };
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
  let tryEntry = localOfStartPc(group.start_pc);
  if (tryEntry < 0) {
    return new Bail(`try start ${group.start_pc} does not land on a block boundary (leaders: ${work.startPc.join(', ')})`);
  }
  const handlerLocals = [];
  for (const c of group.catches) {
    const h = localOfStartPc(c.handler_pc);
    if (h < 0) return new Bail('handler start does not land on a block boundary');
    handlerLocals.push(h);
  }

  // Liveness over normal edges from the method entry AND every handler entry in
  // the whole table (handlers not yet collapsed still carry live code, e.g. the
  // block after a try/catch reachable only via the catch's fall-through).
  // Obfuscators leave dead blocks that fall into live regions; counting their
  // edges fabricates spurious region entries/exits, so we ignore dead blocks.
  const liveRoots = [work.entry];
  for (const pc of (ctx.allHandlerPcs || [])) {
    const h = localOfStartPc(pc);
    if (h >= 0) liveRoots.push(h);
  }
  const reachable = livenessFrom(work, liveRoots);

  // Handler-region dominators need every live exception entry as a root, not
  // only this group's entries. A continuation shared by a nested try and catch
  // is also reachable through the enclosing handler entry; rooting only the
  // nested catch falsely makes that catch dominate the continuation and folds
  // ordinary post-catch code into its body.
  const dominatorRoots = [work.entry];
  for (const pc of (ctx.allHandlerPcs || [])) {
    const h = localOfStartPc(pc);
    if (h >= 0) dominatorRoots.push(h);
  }
  const { idom } = dominatorsFromRoots(work, dominatorRoots);
  const reachableFromCurrentHandlers = livenessFrom(work, handlerLocals);

  // TRY = reachable blocks whose start offset falls inside any of the group's
  // protected ranges (one after same-target row merging is the common case;
  // several when the compiler split one logical try body across table rows).
  // Overlapping table rows can place a catch handler numerically inside another
  // protected range in the same logical group. Such a block is still handler
  // code: handler-entry *dominance*, not mere reachability, distinguishes it —
  // a protected block that is only reachable-from (not dominated-by) a handler
  // is a shared continuation of the try body, and excluding it would emit that
  // protected code outside the try, dropping its exception coverage.
  const tryset = new Set();
  for (let i = 0; i < n; i++) {
    const dominatedByHandler = i !== tryEntry
      && handlerLocals.some((h) => dominates(idom, h, i));
    if (reachable[i] && !dominatedByHandler && inLogicalTryRange(work.startPc[i], group)) tryset.add(i);
  }
  if (!tryset.has(tryEntry)) return new Bail('try entry is outside its own range');

  // A protected range may start with stack-only glue that cannot throw, and an
  // obfuscated branch may enter midway through that glue with equivalent stack
  // operands already prepared. Java cannot spell a try entry in the middle of
  // an expression, but moving the source-level try start forward across blocks
  // that provably cannot throw preserves exception behavior exactly.
  let hasMidTryEntry = false;
  for (let block = 0; block < n && !hasMidTryEntry; block++) {
    if (!reachable[block] || tryset.has(block)) continue;
    for (const target of succOfTerm(work.term[block])) {
      if (target != null && tryset.has(target) && target !== tryEntry) { hasMidTryEntry = true; break; }
    }
  }
  const throwingTryBlocks = hasMidTryEntry
    ? [...tryset].filter((block) => !ctx.isNoThrowBlock(work, block)) : [];
  if (throwingTryBlocks.length) {
    const firstThrowingPc = Math.min(...throwingTryBlocks.map((block) => work.startPc[block]));
    const firstThrowing = localOfStartPc(firstThrowingPc);
    if (firstThrowing >= 0 && firstThrowing !== tryEntry) {
      for (const block of [...tryset]) {
        if (work.startPc[block] < firstThrowingPc && ctx.isNoThrowBlock(work, block)) tryset.delete(block);
      }
      tryEntry = firstThrowing;
    }
  }

  // Extend the try body over trailing no-throw glue. javac ends the protected
  // range just before the `goto merge` that carries the try body's normal
  // completion, so that jump block sits outside the region and would count as a
  // spurious second external exit. A block that cannot throw, is entered only
  // from the try body, and merely transfers control (goto/fall terminator)
  // behaves identically inside or outside the protected range — pull it in.
  {
    const preds = Array.from({ length: n }, () => []);
    for (let b = 0; b < n; b++) {
      if (!reachable[b]) continue;
      for (const t of succOfTerm(work.term[b])) if (t != null) preds[t].push(b);
    }
    const handlerSet = new Set(handlerLocals);
    let changed = true;
    while (changed) {
      changed = false;
      for (let b = 0; b < n; b++) {
        if (tryset.has(b) || handlerSet.has(b) || !reachable[b]) continue;
        if (!preds[b].length || !preds[b].every((p) => tryset.has(p))) continue;
        const k = work.term[b].kind;
        if (k !== 'goto' && k !== 'fall') continue;
        if (!ctx.isNoThrowBlock(work, b)) continue;
        tryset.add(b);
        changed = true;
      }
    }
  }

  // Handler regions: blocks a handler entry dominates (synthetic root over the
  // method entry + all handler entries), minus the try body.
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
    if (!hs.has(h)) {
      return new Bail('handler entry unreachable / not self-dominating');
    }
    handlerSets.push(hs);
  }

  // Whole region and the exits of each independently structured component.
  // A catch can continue back to the try entry (or a try arm can enter a shared
  // handler continuation): that target is internal to the union, but external
  // to the catch/try sub-CFG currently being carved. Include such cross-component
  // edges so structureRegion can terminate at a sink; collapseRegion maps a
  // target inside `region` back to the synthetic super-block, preserving the
  // resulting loop.
  const region = new Set([...tryset, ...inSomeHandler]);
  const externals = new Set();
  for (const component of [tryset, ...handlerSets]) {
    for (const b of component) {
      for (const t of succOfTerm(work.term[b])) {
        if (t != null && !component.has(t)) externals.add(t);
      }
    }
  }
  const externalsList = [...externals];

  // Only the try entry may be targeted from outside the region.
  for (let b = 0; b < n; b++) {
    if (region.has(b) || !reachable[b]) continue;
    for (const t of succOfTerm(work.term[b])) if (t != null && region.has(t) && t !== tryEntry) {
      return new Bail(`region entered other than at its try/handler entry: ${work.startPc[b]} -> ${work.startPc[t]} (entry ${group.start_pc})`);
    }
  }

  // Map each external exit to the render id its sink block uses. One exit (or
  // none) keeps the old single-join shape (empty sink). Several exits allocate a
  // selector variable; each sink assigns `selector = <index>` and the collapsed
  // super-block dispatches on it.
  const superId = ctx.allocId();
  const externalToRenderId = new Map();
  let exits;
  if (externalsList.length <= 1) {
    for (const ext of externalsList) {
      const rid = ctx.allocId();
      ctx.overrides.set(rid, { t: 'seq', body: [] });
      externalToRenderId.set(ext, rid);
    }
    exits = externalsList.map((ext) => ({ external: ext, index: 0 }));
  } else {
    const selectorName = ctx.allocSelector();
    externalsList.forEach((ext, i) => {
      const rid = ctx.allocId();
      ctx.synthetic.set(rid, { straight: [`${selectorName} = ${i};`] });
      externalToRenderId.set(ext, rid);
    });
    exits = externalsList.map((ext, i) => ({ external: ext, index: i }));
    exits.selectorName = selectorName;
  }

  // Structure the try body and each handler as sub-regions that exit to the
  // enumerated sinks. A sink is modeled as a `return` terminator inside the
  // sub-CFG, but it renders as plain text (nothing, or a selector assignment) —
  // so if block layout places another terminal block (a real throw/return merge
  // node) after the sink's inline position, falling through the sink would run
  // that block. Wrap each sub-region in a labeled block and make every sink an
  // explicit `break` to it: reaching a sink always means "leave the region now".
  const sinkRids = new Set(externalToRenderId.values());
  const wrapRegionExits = (tree) => {
    let used = false;
    const walk = (node) => {
      if (!node) return node;
      switch (node.t) {
        case 'straight':
          if (!sinkRids.has(node.block)) return node;
          used = true;
          return { t: 'seq', body: [node, { t: 'break', label: REGION_EXIT_LABEL }] };
        case 'seq': return { t: 'seq', body: node.body.map(walk) };
        case 'block': return { ...node, body: walk(node.body) };
        case 'loop': return { ...node, body: walk(node.body) };
        case 'if': return { ...node, then: walk(node.then), els: node.els ? walk(node.els) : null };
        case 'switch': return {
          ...node,
          cases: node.cases.map((c) => ({ ...c, body: walk(c.body) })),
          dflt: node.dflt ? walk(node.dflt) : null,
        };
        default: return node;
      }
    };
    const body = walk(tree);
    return used ? { t: 'block', label: REGION_EXIT_LABEL, body } : body;
  };

  let tryTree = structureRegion(work, tryset, tryEntry, externalToRenderId, ctx);
  if (tryTree instanceof Bail) return tryTree;
  tryTree = wrapRegionExits(tryTree);

  // A group whose sole catch-all handler is the lowered monitorexit+rethrow
  // idiom (see cfr.js lowerSynchronizedRegions) is a `synchronized` block, not a
  // try/catch: the body becomes `synchronized (lock) { ... }` and the handler —
  // pure lock-release plumbing the Java construct reintroduces implicitly — is
  // carved away with the region and never rendered.
  const sync = group.catches.length === 1 && ctx.syncHandlers
    ? ctx.syncHandlers.get(group.catches[0].handler_pc)
    : null;
  let tryNode;
  if (sync) {
    tryNode = { t: 'synchronized', lockLocal: sync.lockLocal, lockPc: sync.lockPc, body: tryTree };
  } else {
    const catches = [];
    for (let ci = 0; ci < group.catches.length; ci++) {
      let hTree = structureRegion(work, handlerSets[ci], handlerLocals[ci], externalToRenderId, ctx);
      if (hTree instanceof Bail) return hTree;
      hTree = wrapRegionExits(hTree);
      catches.push({
        types: renderCatchTypes(group.catches[ci].catch_type),
        varName: 'decompiledCaughtParameter',
        carrierName: 'decompiledCaughtException',
        body: hTree,
      });
    }
    tryNode = { t: 'try', body: tryTree, catches };
    // A broader handler followed by a narrower one cannot be represented as
    // sibling Java catches ("exception X has already been caught"). Such JVM
    // tables describe nested protected ranges: the later handler also covers
    // failures thrown by the earlier handler. Keep that ordering by wrapping
    // the earlier handlers in an inner try. Repeat while any later catch is
    // still subsumed by an earlier sibling.
    for (;;) {
      const siblings = tryNode.catches;
      const shadowed = siblings.findIndex((item, index) => index > 0
        && siblings.slice(0, index).some((earlier) => catchTypesSubsumes(earlier.types, item.types)));
      if (shadowed <= 0) break;
      tryNode = {
        t: 'try',
        body: { t: 'try', body: tryNode.body, catches: siblings.slice(0, shadowed) },
        catches: siblings.slice(shadowed),
      };
    }
  }
  ctx.overrides.set(superId, tryNode);
  commit(collapseRegion(work, region, superId, group.start_pc, exits, ctx));
  return undefined;
}

module.exports = {
  structureMethod,
  // exposed for tests
  normalizeTable,
  renderCatchType,
};
