'use strict';

const { treeToStatements, emitStatements } = require('./javaAstEmitter');

/**
 * structurer — provably-correct control-flow structuring.
 *
 * Given a reducible control-flow graph, produce a structured statement tree that
 * uses only Java's structured control flow: `if`/`else`, `while (true)`, labeled
 * blocks, `break label`, `continue label`, `switch`, `return`/`throw`. No
 * `goto`, ever. This is the component a pattern-matching decompiler (proto-CFR's
 * `decompileStructuredControlFlow`) lacks: instead of recognising a fixed
 * catalogue of shapes and bailing to `goto` on anything else, it structures
 * *every* reducible CFG by construction.
 *
 * Algorithm: Norman Ramsey, "Beyond Relooper: Recursive Translation of
 * Unstructured Control Flow to Structured Control Flow" (ICFP 2022), specialised
 * from WebAssembly's block/loop/br to Java's labeled statements. The recursion:
 *
 *   - Each node is emitted exactly once, at the point it is dominated.
 *   - A *merge node* (>= 2 forward predecessors) cannot be inlined at one
 *     predecessor, so its immediate dominator wraps the code that precedes it in
 *     a labeled block; every forward edge into it becomes `break <block>`.
 *   - A *loop header* (target of a back edge) is wrapped in `while (true)`; every
 *     back edge into it becomes `continue <loop>`.
 *   - Any other edge whose target this node immediately dominates is inlined
 *     directly (the target has a single forward predecessor).
 *
 * Reducibility is the precondition and is checked up front: a retreating edge
 * whose target does not dominate its source makes the CFG irreducible, and the
 * structurer throws `IrreducibleError`. `regionSplit` converts such a CFG into a
 * reducible one, after which structuring succeeds — that is the whole pipeline.
 *
 * This module is deliberately decoupled from bytecode: it consumes an abstract
 * CFG whose blocks carry a terminator descriptor and opaque `straight` bodies,
 * so the algorithm can be unit-tested on synthetic graphs and reused for any
 * front end. `buildCfgFromCode` adapts Krakatau-style codeItems into that shape.
 */

class IrreducibleError extends Error {
  constructor(message, edges) { super(message); this.name = 'IrreducibleError'; this.edges = edges || []; }
}

// ---------------------------------------------------------------------------
// Graph analyses: reverse postorder, dominators (Cooper-Harvey-Kennedy),
// retreating/back edges, merge nodes.
// ---------------------------------------------------------------------------

function reversePostorder(succ, entry) {
  const n = succ.length;
  const visited = new Array(n).fill(false);
  const post = [];
  // iterative postorder DFS
  const stack = [[entry, 0]];
  visited[entry] = true;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const [u, ptr] = frame;
    if (ptr < succ[u].length) {
      frame[1]++;
      const v = succ[u][ptr];
      if (!visited[v]) { visited[v] = true; stack.push([v, 0]); }
    } else {
      post.push(u);
      stack.pop();
    }
  }
  const rpo = post.reverse();
  const rpoIndex = new Array(n).fill(-1);
  rpo.forEach((node, i) => { rpoIndex[node] = i; });
  return { rpo, rpoIndex, reachable: visited };
}

function computeDominators(succ, entry, rpo, rpoIndex) {
  const n = succ.length;
  const preds = Array.from({ length: n }, () => []);
  for (let u = 0; u < n; u++) for (const v of succ[u]) preds[v].push(u);
  const idom = new Array(n).fill(-1);
  idom[entry] = entry;
  const intersect = (a, b) => {
    while (a !== b) {
      while (rpoIndex[a] > rpoIndex[b]) a = idom[a];
      while (rpoIndex[b] > rpoIndex[a]) b = idom[b];
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const u of rpo) {
      if (u === entry) continue;
      let newIdom = -1;
      for (const p of preds[u]) {
        if (idom[p] === -1) continue; // not yet processed
        newIdom = newIdom === -1 ? p : intersect(p, newIdom);
      }
      if (newIdom !== -1 && idom[u] !== newIdom) { idom[u] = newIdom; changed = true; }
    }
  }
  return { idom, preds };
}

function dominates(idom, a, b) {
  // does a dominate b?
  let x = b;
  for (;;) {
    if (x === a) return true;
    if (x === idom[x]) return x === a; // reached entry (idom[entry]=entry)
    x = idom[x];
  }
}

/**
 * Classify edges and detect irreducibility. Returns backEdges (Set of "u->v"),
 * loopHeaders (Set of v), and forward predecessor counts. Throws
 * IrreducibleError if any retreating edge is not a back edge.
 */
function classifyEdges(succ, rpoIndex, idom, reachable) {
  const n = succ.length;
  const backEdges = new Set();
  const loopHeaders = new Set();
  const forwardPreds = new Array(n).fill(0);
  const bad = [];
  for (let u = 0; u < n; u++) {
    if (!reachable[u]) continue;
    for (const v of succ[u]) {
      if (!reachable[v]) continue;
      const retreating = rpoIndex[v] <= rpoIndex[u];
      if (retreating) {
        if (dominates(idom, v, u)) {
          backEdges.add(`${u}->${v}`);
          loopHeaders.add(v);
        } else {
          bad.push(`${u}->${v}`);
        }
      } else {
        forwardPreds[v] += 1;
      }
    }
  }
  if (bad.length) {
    throw new IrreducibleError(`irreducible CFG: ${bad.length} non-dominating retreating edge(s)`, bad);
  }
  return { backEdges, loopHeaders, forwardPreds };
}

// ---------------------------------------------------------------------------
// Ramsey structuring.
// ---------------------------------------------------------------------------

/**
 * Structure a reducible CFG into a statement tree.
 *
 * cfg = {
 *   n, entry,
 *   succ:   [[blockId...]],           // successor block ids (for graph analyses)
 *   term:   [ descriptor per block ], // how the block ends; see below
 * }
 * term descriptor kinds:
 *   {kind:'cond',   taken, fall}      conditional branch; two successors
 *   {kind:'goto',   target}           unconditional
 *   {kind:'fall',   target}           straight-line fall-through
 *   {kind:'return'}                   return/throw; no successors
 *   {kind:'switch', cases:[{key,target}], default}
 *
 * Returns { tree } — a nested statement node (see printer for node shapes).
 */
function structure(cfg) {
  const { succ, entry } = cfg;
  // succAll keeps parallel edges (a conditional whose two arms hit the same
  // block, or two switch cases sharing a target). Dominators/RPO use the deduped
  // `succ`, but forward-predecessor *counts* must see multiplicity: a block
  // reached by two edges — even from one predecessor — is a merge node and must
  // get its own labeled block, or it would be inlined once per arm (emitted
  // twice).
  const succAll = cfg.succAll || succ;
  const { rpo, rpoIndex, reachable } = reversePostorder(succ, entry);
  const { idom } = computeDominators(succ, entry, rpo, rpoIndex);
  const { backEdges, loopHeaders, forwardPreds } = classifyEdges(succAll, rpoIndex, idom, reachable);

  const isMerge = (b) => forwardPreds[b] >= 2;
  const isBackEdge = (u, v) => backEdges.has(`${u}->${v}`);

  // immediate-dominatee children
  const domChildren = Array.from({ length: cfg.n }, () => []);
  for (let b = 0; b < cfg.n; b++) {
    if (!reachable[b] || b === entry) continue;
    if (idom[b] >= 0) domChildren[idom[b]].push(b);
  }

  const emitted = new Set();

  function doTree(x, context) {
    // Merge-node dominatees of x, placed outermost-last: sort by RPO descending
    // so the latest-in-program-order merge node is emitted last.
    const merges = domChildren[x].filter(isMerge).sort((a, b) => rpoIndex[b] - rpoIndex[a]);
    if (loopHeaders.has(x)) {
      // The loop must wrap *everything* for x — including the labeled blocks for
      // x's merge-node dominatees, which are part of the loop body. Establish the
      // continue target before placing them, so a back edge from a merge node
      // inside the loop resolves to this header.
      const loopCtx = [{ type: 'loop', node: x }, ...context];
      return { t: 'loop', label: labelFor(x), body: nodeWithin(x, merges, loopCtx) };
    }
    return nodeWithin(x, merges, context);
  }

  function nodeWithin(x, merges, context) {
    if (merges.length === 0) {
      return codeForNode(x, context);
    }
    const [y, ...rest] = merges;
    const blockCtx = [{ type: 'block', node: y }, ...context];
    const inner = nodeWithin(x, rest, blockCtx);
    const after = doTree(y, context);
    return { t: 'seq', body: [{ t: 'block', label: labelFor(y), body: inner }, after] };
  }

  function codeForNode(x, context) {
    if (emitted.has(x)) {
      // Should never happen for a reducible CFG; a guard against silent double
      // emission (which would signal a bug in the analyses above).
      throw new Error(`block ${x} emitted twice`);
    }
    emitted.add(x);
    const parts = [{ t: 'straight', block: x }];
    const term = cfg.term[x];
    switch (term.kind) {
      case 'return':
        // the return/throw is part of the straight body
        break;
      case 'goto':
      case 'fall':
        parts.push(branchTo(x, term.target, context));
        break;
      case 'cond':
        parts.push({
          t: 'if',
          block: x,
          then: branchTo(x, term.taken, context),
          els: branchTo(x, term.fall, context),
        });
        break;
      case 'switch': {
        const cases = term.cases.map((c) => ({ key: c.key, body: branchTo(x, c.target, context) }));
        const dflt = term.default != null ? branchTo(x, term.default, context) : null;
        parts.push({ t: 'switch', block: x, cases, dflt });
        break;
      }
      default:
        throw new Error(`unknown terminator kind ${term.kind} on block ${x}`);
    }
    return parts.length === 1 ? parts[0] : { t: 'seq', body: parts };
  }

  function branchTo(from, target, context) {
    if (isBackEdge(from, target)) {
      requireFrame(context, 'loop', target, from);
      return { t: 'continue', label: labelFor(target) };
    }
    if (idom[target] === from && !isMerge(target)) {
      // Sole forward predecessor dominates it: inline directly.
      return doTree(target, context);
    }
    // Merge node placed in an enclosing labeled block by its idom.
    requireFrame(context, 'block', target, from);
    return { t: 'break', label: labelFor(target) };
  }

  function requireFrame(context, type, node, from) {
    if (!context.some((f) => f.type === type && f.node === node)) {
      throw new Error(`no enclosing ${type} for edge ${from}->${node} (structuring invariant violated)`);
    }
  }

  const tree = doTree(entry, []);
  // Every reachable block must be emitted exactly once.
  for (let b = 0; b < cfg.n; b++) {
    if (reachable[b] && !emitted.has(b)) throw new Error(`block ${b} never emitted`);
  }
  return { tree, idom, rpo, loopHeaders, mergeNodes: new Set([...Array(cfg.n).keys()].filter(isMerge)) };
}

function labelFor(blockId) { return `L${blockId}`; }

/**
 * Rename every block/loop frame to a globally-unique label and rewrite each
 * break/continue to its nearest enclosing frame's new name.
 *
 * `structure()` labels frames `L<blockId>`, unique within a single call. But the
 * exception layer composes several independent `structure()` results (a try body
 * nested inside the method), so two frames from different sub-trees can share a
 * name and end up *nested* — which is a Java compile error ("label already in
 * use"). Break/continue already resolve to the lexically nearest matching frame
 * (semantically correct, since each sub-tree's jumps only ever target its own
 * frames), so a pure rename that preserves nearest-match resolution fixes the
 * clash without changing behaviour. Mutates the tree in place and returns it.
 */
function uniquifyLabels(tree) {
  let counter = 0;
  // Every frame is renamed, so a plain sequential `L<n>` is collision-free and
  // keeps labels in the same visual form the base structurer emits.
  const fresh = () => `L${counter++}`;
  function walk(node, scope) {
    if (!node) return;
    switch (node.t) {
      case 'block':
      case 'loop': {
        const nl = fresh();
        const inner = [{ old: node.label, fresh: nl }, ...scope];
        node.label = nl;
        walk(node.body, inner);
        break;
      }
      case 'seq':
        for (const c of node.body) walk(c, scope);
        break;
      case 'if':
        walk(node.then, scope); walk(node.els, scope);
        break;
      case 'switch':
        for (const c of node.cases) walk(c.body, scope);
        walk(node.dflt, scope);
        break;
      case 'try':
        walk(node.body, scope);
        for (const c of node.catches) walk(c.body, scope);
        break;
      case 'synchronized':
        walk(node.body, scope);
        break;
      case 'break':
      case 'continue': {
        const frame = scope.find((f) => f.old === node.label);
        if (!frame) throw new Error(`unresolved ${node.t} ${node.label} during label uniquify`);
        node.label = frame.fresh;
        break;
      }
      default: // straight / anything else: no labels
        break;
    }
  }
  walk(tree, []);
  return tree;
}

// Every catch clause the exception structurer emits uses one fixed parameter
// name (`decompiledCaughtParameter`). When one try/catch nests inside another
// catch's body — `catch (IOException e) { try { … } catch (Exception e) { … } }`
// — the inner parameter re-declares a name still in scope from the outer catch,
// which javac rejects ("variable … is already defined"). The catch body never
// references the parameter directly (its only use is the emitter-generated
// `carrier = <param>;` copy, which reads the node's varName), so a fresh unique
// name per clause is always safe. Rename every catch parameter sequentially.
function uniquifyCatchParameters(tree) {
  let counter = 0;
  function walk(node) {
    if (!node) return;
    switch (node.t) {
      case 'seq':
        for (const c of node.body) walk(c);
        break;
      case 'block':
      case 'loop':
      case 'synchronized':
        walk(node.body);
        break;
      case 'if':
        walk(node.then); walk(node.els);
        break;
      case 'switch':
        for (const c of node.cases) walk(c.body);
        walk(node.dflt);
        break;
      case 'try':
        walk(node.body);
        for (const c of node.catches) {
          if (c.varName) c.varName = `${c.varName}${counter++}`;
          walk(c.body);
        }
        break;
      default:
        break;
    }
  }
  walk(tree);
  return tree;
}

// ---------------------------------------------------------------------------
// Printer: statement tree -> Java-ish source lines. Bodies are rendered via a
// pluggable `render` so the algorithm can be exercised on abstract graphs.
// ---------------------------------------------------------------------------

const DEFAULT_RENDER = {
  straight: (id) => [`stmt_${id}();`],
  cond: (id) => `c${id}`,
  switchValue: (id) => `sel${id}`,
};

function printTree(tree, render = DEFAULT_RENDER) {
  repairEmptyLoopExits(tree, []);
  return emitStatements(treeToStatements(tree, render));
}

function repairEmptyLoopExits(node, loopLabels) {
  if (!node) return;
  if (node.t === 'loop') {
    repairEmptyLoopExits(node.body, [...loopLabels, node.label]);
    return;
  }
  if (node.t === 'if') {
    const label = loopLabels[loopLabels.length - 1];
    if (label && isEmptyTree(node.then) && !isEmptyTree(node.els)) node.then = { t: 'break', label };
    repairEmptyLoopExits(node.then, loopLabels);
    repairEmptyLoopExits(node.els, loopLabels);
    return;
  }
  if (node.t === 'seq') for (const child of node.body || []) repairEmptyLoopExits(child, loopLabels);
  else if (node.t === 'block') repairEmptyLoopExits(node.body, loopLabels);
  else if (node.t === 'switch') {
    for (const item of node.cases || []) repairEmptyLoopExits(item.body, loopLabels);
    repairEmptyLoopExits(node.dflt, loopLabels);
  } else if (node.t === 'try') {
    repairEmptyLoopExits(node.body, loopLabels);
    for (const item of node.catches || []) repairEmptyLoopExits(item.body, loopLabels);
  } else if (node.t === 'synchronized') {
    repairEmptyLoopExits(node.body, loopLabels);
  }
}

function isEmptyTree(node) {
  if (!node) return true;
  return node.t === 'seq' && (node.body || []).every(isEmptyTree);
}

// ---------------------------------------------------------------------------
// Adapter: Krakatau-style codeItems -> abstract CFG. Every instruction item
// carries an offset labelDef; only *referenced* labels are block boundaries.
// Exception edges are not modelled here (try/catch is a separate structuring
// layer); a method with handler-only-reachable blocks will report them as
// unreachable, which the caller can detect.
// ---------------------------------------------------------------------------

const CFG_CONDITIONAL = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne', 'ifnull', 'ifnonnull',
]);
const CFG_TERMINAL = new Set(['ret', 'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow']);

function cfgOp(insn) { return !insn ? null : (typeof insn === 'string' ? insn : insn.op || null); }
function cfgTrim(l) { return typeof l === 'string' && l.endsWith(':') ? l.slice(0, -1) : l; }

function collectRefdLabels(codeItems) {
  const set = new Set();
  const add = (l) => { if (typeof l === 'string') set.add(cfgTrim(l)); };
  for (const item of codeItems) {
    const insn = item && item.instruction;
    if (!insn) continue;
    const op = cfgOp(insn);
    if (op === 'goto' || op === 'goto_w' || op === 'jsr' || CFG_CONDITIONAL.has(op)) add(insn.arg);
    else if (op === 'tableswitch') { for (const l of (insn.labels || [])) add(l); add(insn.defaultLbl); }
    else if (op === 'lookupswitch' && insn.arg && typeof insn.arg === 'object') {
      for (const p of (insn.arg.pairs || [])) if (Array.isArray(p)) add(p[1]);
      add(insn.arg.defaultLabel);
    }
  }
  return set;
}

/**
 * Build the abstract CFG (n, entry, succ, term) for one method's codeItems, plus
 * `blocks` (each block's item indices and head label) so a caller can render the
 * straight-line bodies. Returns null if there are no instructions.
 */
function buildCfgFromCode(codeItems, forcedLeaderLabels = [], forcedLeaderPcs = []) {
  const referenced = collectRefdLabels(codeItems);
  for (const label of forcedLeaderLabels) {
    if (typeof label === 'string') referenced.add(cfgTrim(label));
  }
  // Some block boundaries are not label/branch targets — notably an exception
  // table's try `start_pc`, which the JVM protects but which no instruction jumps
  // to, so it may sit mid-block. Callers that need a leader there (the exception
  // structurer, so the try body lands on a block boundary) pass its pc here.
  const forcedPcSet = new Set();
  for (const pc of forcedLeaderPcs) if (pc != null && Number.isFinite(Number(pc))) forcedPcSet.add(Number(pc));

  const insnIdx = [];
  for (let i = 0; i < codeItems.length; i++) if (codeItems[i] && codeItems[i].instruction) insnIdx.push(i);
  const nI = insnIdx.length;
  if (nI === 0) return null;
  const labelOf = (ii) => (codeItems[ii].labelDef ? cfgTrim(codeItems[ii].labelDef) : null);

  const isLeader = new Array(nI).fill(false);
  isLeader[0] = true;
  for (let k = 0; k < nI; k++) {
    const lbl = labelOf(insnIdx[k]);
    if (lbl && referenced.has(lbl)) isLeader[k] = true;
    if (forcedPcSet.size) {
      const pc = codeItems[insnIdx[k]].pc;
      if (pc != null && forcedPcSet.has(Number(pc))) isLeader[k] = true;
    }
    const op = cfgOp(codeItems[insnIdx[k]].instruction);
    const ender = op === 'goto' || op === 'goto_w' || op === 'jsr' || op === 'tableswitch'
      || op === 'lookupswitch' || CFG_CONDITIONAL.has(op) || CFG_TERMINAL.has(op);
    if (ender && k + 1 < nI) isLeader[k + 1] = true;
  }

  const blocks = [];
  let cur = null;
  for (let k = 0; k < nI; k++) {
    if (isLeader[k]) { cur = { id: blocks.length, insns: [] }; blocks.push(cur); }
    cur.insns.push(insnIdx[k]);
  }
  const byLabel = new Map();
  for (const b of blocks) {
    b.headLabel = labelOf(b.insns[0]);
    if (b.headLabel && referenced.has(b.headLabel)) byLabel.set(b.headLabel, b.id);
  }
  const blockOfLabel = (l) => { const v = byLabel.get(cfgTrim(l)); return v == null ? null : v; };

  const succ = [];
  const succAll = [];
  const term = [];
  for (const b of blocks) {
    const lastIi = b.insns[b.insns.length - 1];
    const insn = codeItems[lastIi].instruction;
    const op = cfgOp(insn);
    const next = b.id + 1 < blocks.length ? b.id + 1 : null;
    let t;
    if (op === 'goto' || op === 'goto_w') {
      t = { kind: 'goto', target: blockOfLabel(insn.arg) };
    } else if (CFG_CONDITIONAL.has(op)) {
      t = { kind: 'cond', taken: blockOfLabel(insn.arg), fall: next };
    } else if (CFG_TERMINAL.has(op)) {
      t = { kind: 'return' };
    } else if (op === 'tableswitch') {
      const cases = (insn.labels || []).map((l, i) => ({ key: i, target: blockOfLabel(l) }));
      t = { kind: 'switch', cases, default: insn.defaultLbl != null ? blockOfLabel(insn.defaultLbl) : null };
    } else if (op === 'lookupswitch' && insn.arg && typeof insn.arg === 'object') {
      const cases = (insn.arg.pairs || []).filter(Array.isArray).map((p) => ({ key: p[0], target: blockOfLabel(p[1]) }));
      t = { kind: 'switch', cases, default: insn.arg.defaultLabel != null ? blockOfLabel(insn.arg.defaultLabel) : null };
    } else {
      t = { kind: 'fall', target: next };
    }
    // Drop edges to null (malformed/last-block fallthrough) defensively.
    term.push(t);
    succ.push(succOfTerm(t));
    succAll.push(succAllOfTerm(t));
  }
  return { n: blocks.length, entry: 0, succ, succAll, term, blocks };
}

/** All out-edges *with* multiplicity (parallel edges kept), for merge-node
 * counting. `succOfTerm` dedups these for the dominator/RPO graph. */
function succAllOfTerm(t) {
  switch (t.kind) {
    case 'return': return [];
    case 'goto': case 'fall': return t.target == null ? [] : [t.target];
    case 'cond': {
      const s = [];
      if (t.taken != null) s.push(t.taken);
      if (t.fall != null) s.push(t.fall);
      return s;
    }
    case 'switch': {
      const s = [];
      for (const c of t.cases) if (c.target != null) s.push(c.target);
      if (t.default != null) s.push(t.default);
      return s;
    }
    default: return [];
  }
}

function succOfTerm(t) {
  switch (t.kind) {
    case 'return': return [];
    case 'goto': case 'fall': return t.target == null ? [] : [t.target];
    case 'cond': {
      const s = [];
      if (t.taken != null) s.push(t.taken);
      if (t.fall != null && t.fall !== t.taken) s.push(t.fall);
      return s;
    }
    case 'switch': {
      const s = new Set();
      for (const c of t.cases) if (c.target != null) s.add(c.target);
      if (t.default != null) s.add(t.default);
      return [...s];
    }
    default: return [];
  }
}

module.exports = {
  IrreducibleError,
  structure,
  printTree,
  uniquifyLabels,
  uniquifyCatchParameters,
  buildCfgFromCode,
  // exposed for reuse/testing
  reversePostorder,
  computeDominators,
  dominates,
  classifyEdges,
  succOfTerm,
  succAllOfTerm,
};
