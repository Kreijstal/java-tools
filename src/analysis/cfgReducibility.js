'use strict';

/**
 * cfgReducibility — fast, CFR-free measure of how "unstructurable" a method's
 * control flow is, used to guide node-splitting without a decompiler in the
 * loop.
 *
 * CFR emits `** GOTO` / "Unable to fully structure code" primarily on
 * *irreducible* control flow: a loop entered at more than one point (a retreating
 * edge whose target does not dominate its source). `methodIrreducibility`
 * builds the basic-block CFG from codeItems and counts irreducible retreating
 * edges — 0 means the CFG is reducible (which CFR structures cleanly). A split
 * that lowers this count is moving toward a structurable method, so the search
 * can rank thousands of candidates in milliseconds and only confirm the winner
 * with a real CFR run.
 *
 * Exception edges are ignored: CFR models try/catch structurally on the side,
 * and the residual gotos in this corpus are ordinary control flow.
 */

const CONDITIONAL_JUMPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
]);
const TERMINALS = new Set(['return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow', 'ret']);

function methodIrreducibility(codeItems) {
  const cfg = buildBlocks(codeItems);
  if (cfg.n <= 1) return 0;
  return countIrreducibleEdges(cfg);
}

/** Sum of methodIrreducibility across every method in an AST. */
function astIrreducibility(astRoot, filterName) {
  let total = 0;
  for (const classItem of (astRoot.classes || [])) {
    for (const item of (classItem.items || [])) {
      if (!item || item.type !== 'method' || !item.method) continue;
      if (filterName && item.method.name !== filterName) continue;
      const codeAttr = (item.method.attributes || []).find((a) => a.type === 'code');
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) continue;
      total += methodIrreducibility(codeAttr.code.codeItems);
    }
  }
  return total;
}

function buildBlocks(codeItems) {
  const insns = [];
  for (const it of codeItems) {
    if (it && it.instruction) insns.push({ label: it.labelDef ? trim(it.labelDef) : null, insn: it.instruction });
  }
  const n = insns.length;
  if (n === 0) return { n: 0, succ: [] };

  const labelToIdx = new Map();
  for (let i = 0; i < n; i++) if (insns[i].label) labelToIdx.set(insns[i].label, i);

  const leader = new Array(n).fill(false);
  leader[0] = true;
  for (let i = 0; i < n; i++) {
    const op = getOp(insns[i].insn);
    for (const t of targetsOf(insns[i].insn, op)) {
      const j = labelToIdx.get(trim(t));
      if (j != null) leader[j] = true;
    }
    if ((op === 'goto' || CONDITIONAL_JUMPS.has(op) || op === 'tableswitch' || op === 'lookupswitch' || TERMINALS.has(op)) && i + 1 < n) {
      leader[i + 1] = true;
    }
  }

  const blockOf = new Array(n);
  let bid = -1;
  for (let i = 0; i < n; i++) { if (leader[i]) bid++; blockOf[i] = bid; }
  const nblocks = bid + 1;

  const succ = Array.from({ length: nblocks }, () => new Set());
  const blockOfLabel = (t) => { const j = labelToIdx.get(trim(t)); return j == null ? null : blockOf[j]; };
  for (let i = 0; i < n; i++) {
    const b = blockOf[i];
    const isLast = i + 1 >= n || blockOf[i + 1] !== b;
    if (!isLast) continue;
    const op = getOp(insns[i].insn);
    const tgts = targetsOf(insns[i].insn, op);
    if (op === 'goto') {
      for (const t of tgts) { const s = blockOfLabel(t); if (s != null) succ[b].add(s); }
    } else if (CONDITIONAL_JUMPS.has(op)) {
      for (const t of tgts) { const s = blockOfLabel(t); if (s != null) succ[b].add(s); }
      if (i + 1 < n) succ[b].add(blockOf[i + 1]);
    } else if (op === 'tableswitch' || op === 'lookupswitch') {
      for (const t of tgts) { const s = blockOfLabel(t); if (s != null) succ[b].add(s); }
    } else if (TERMINALS.has(op)) {
      // no successors
    } else if (i + 1 < n) {
      succ[b].add(blockOf[i + 1]);
    }
  }
  return { n: nblocks, succ: succ.map((s) => [...s]) };
}

/**
 * Count irreducible retreating edges. Do a DFS from block 0 recording
 * entry/exit times (ancestor test) and the DFS tree; compute dominators
 * iteratively; a retreating edge u->v (v is a DFS ancestor of u) is irreducible
 * iff v does not dominate u.
 */
function countIrreducibleEdges(cfg) {
  const { n, succ } = cfg;
  const enter = new Array(n).fill(-1);
  const exit = new Array(n).fill(-1);
  const order = [];
  let timer = 0;
  // iterative DFS
  const state = new Array(n).fill(0); // 0 unvisited, 1 on-stack, 2 done
  const stack = [[0, 0]];
  enter[0] = timer++; state[0] = 1; order.push(0);
  while (stack.length) {
    const top = stack[stack.length - 1];
    const [u, ptr] = top;
    if (ptr < succ[u].length) {
      top[1]++;
      const v = succ[u][ptr];
      if (state[v] === 0) { enter[v] = timer++; state[v] = 1; order.push(v); stack.push([v, 0]); }
    } else {
      exit[u] = timer++; state[u] = 2; stack.pop();
    }
  }
  const isAncestor = (a, b) => enter[a] >= 0 && enter[b] >= 0 && enter[a] <= enter[b] && exit[b] <= exit[a];

  // Dominators (Cooper-Harvey-Kennedy) over reverse-postorder of reachable nodes.
  const rpo = order.slice().sort((a, b) => enter[a] - enter[b]); // preorder ≈ good enough seed
  const idom = new Array(n).fill(-1);
  idom[0] = 0;
  const rpoIndex = new Array(n).fill(-1);
  const reachable = order.filter((x) => enter[x] >= 0);
  const rpoOrder = reachable.slice().sort((a, b) => exit[b] - exit[a]); // reverse postorder
  rpoOrder.forEach((node, i) => { rpoIndex[node] = i; });
  const preds = Array.from({ length: n }, () => []);
  for (let u = 0; u < n; u++) for (const v of succ[u]) preds[v].push(u);
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
    for (const u of rpoOrder) {
      if (u === 0) continue;
      let newIdom = -1;
      for (const p of preds[u]) {
        if (idom[p] === -1) continue;
        newIdom = newIdom === -1 ? p : intersect(newIdom, p);
      }
      if (newIdom !== -1 && idom[u] !== newIdom) { idom[u] = newIdom; changed = true; }
    }
  }
  const dominates = (a, b) => {
    if (a === b) return true;
    let x = b;
    while (x !== -1 && x !== idom[x]) { x = idom[x]; if (x === a) return true; }
    return a === 0; // entry dominates all reachable
  };

  let irreducible = 0;
  for (let u = 0; u < n; u++) {
    if (enter[u] < 0) continue;
    for (const v of succ[u]) {
      if (enter[v] < 0) continue;
      // retreating edge: v is an ancestor of u in the DFS tree (incl. u===v self-loop)
      if (isAncestor(v, u)) {
        if (!dominates(v, u)) irreducible++;
      }
    }
  }
  return irreducible;
}

function targetsOf(insn, op) {
  if (op === 'goto' || op === 'jsr' || CONDITIONAL_JUMPS.has(op)) {
    return typeof insn.arg === 'string' ? [insn.arg] : [];
  }
  if (op === 'tableswitch') {
    const out = Array.isArray(insn.labels) ? insn.labels.slice() : [];
    if (typeof insn.defaultLbl === 'string') out.push(insn.defaultLbl);
    return out;
  }
  if (op === 'lookupswitch' && insn.arg && typeof insn.arg === 'object') {
    const out = [];
    for (const pair of (insn.arg.pairs || [])) if (Array.isArray(pair) && typeof pair[1] === 'string') out.push(pair[1]);
    if (typeof insn.arg.defaultLabel === 'string') out.push(insn.arg.defaultLabel);
    return out;
  }
  return [];
}

function getOp(insn) { return insn && (typeof insn === 'string' ? insn : insn.op) || null; }
function trim(l) { return typeof l === 'string' && l.endsWith(':') ? l.slice(0, -1) : l; }

module.exports = { methodIrreducibility, astIrreducibility };
