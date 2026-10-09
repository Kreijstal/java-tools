'use strict';

// Check normal control flow before Java expression folding or printer cleanup.
// Labels are epsilon edges, not evidence of a CFG destination. Reconstruct the
// next executed block on each arm and compare it with the retained source CFG.
// Duplicated blocks from controlled splitting may have several occurrences;
// every occurrence must preserve the original edges, including branch polarity.
function verifyStructuredFlow(tree, flow) {
  if (!flow || !Array.isArray(flow.blocks)) return false;
  const terms = new Map();
  for (const item of flow.blocks) {
    if (!item || !Number.isSafeInteger(item.block) || item.block < 0 ||
        terms.has(item.block) || !item.term) return false;
    terms.set(item.block, item.term);
  }
  if (!terms.has(flow.entry)) return false;
  const end = {kind: 'end'};
  let valid = true;
  const build = (node, next, frames) => {
    if (!node) return next;
    // A previously collapsed inner region is one block of this component's
    // CFG. Its own components are checked independently after composition.
    if (node.regionFlowBlock != null) {
      if (node.t !== 'try' && node.t !== 'synchronized') { valid = false; return end; }
      return {kind: 'straight', block: node.regionFlowBlock, next};
    }
    switch (node.t) {
      case 'straight': return {kind: 'straight', block: node.block, next};
      case 'seq': {
        if (!Array.isArray(node.body)) { valid = false; return end; }
        let tail = next;
        for (let i = node.body.length - 1; i >= 0; i--) tail = build(node.body[i], tail, frames);
        return tail;
      }
      case 'block':
        return build(node.body, next, [...frames, {label: node.label, breakTo: next}]);
      case 'loop': {
        const header = {kind: 'ref', target: null};
        header.target = build(node.body, header, [...frames,
          {label: node.label, breakTo: next, continueTo: header}]);
        return header;
      }
      case 'break': case 'continue': {
        const frame = [...frames].reverse().find(item => item.label === node.label);
        const target = frame && (node.t === 'break' ? frame.breakTo : frame.continueTo);
        if (!target) { valid = false; return end; }
        return target;
      }
      case 'if': return {kind: 'cond', block: node.block,
        taken: build(node.then, next, frames), fall: build(node.els, next, frames)};
      case 'switch': {
        if (!Array.isArray(node.cases)) { valid = false; return end; }
        // The Java emitter uses colon cases without an implicit break. A case
        // that loses its transfer falls into the next group, not past switch.
        const dflt = node.dflt ? build(node.dflt, next, frames) : null;
        const cases = new Array(node.cases.length);
        let tail = dflt || next;
        for (let i = node.cases.length - 1; i >= 0; i--) {
          const item = node.cases[i];
          const target = build(item.body, tail, frames);
          cases[i] = {key: item.key, target};
          tail = target;
        }
        return {kind: 'switch', block: node.block, cases, default: dflt};
      }
      default:
        // Unmarked try/synchronized/legacy exit nodes cannot silently supply
        // an edge. The source contract does not describe their semantics.
        valid = false;
        return end;
    }
  };
  const resolve = node => {
    const visited = new Set();
    while (node?.kind === 'ref') {
      if (visited.has(node)) { valid = false; return end; }
      visited.add(node);
      node = node.target;
    }
    return node;
  };
  const root = resolve(build(tree, end, []));
  const pending = [];
  const edge = (node, target) => {
    const destination = resolve(node);
    if (destination?.kind !== 'straight' || destination.block !== target || !terms.has(target))
      valid = false;
    else pending.push(destination);
  };
  edge(root, flow.entry);
  const visited = new Set(), seenBlocks = new Set();
  while (pending.length && valid) {
    const node = pending.pop();
    if (visited.has(node)) continue;
    visited.add(node); seenBlocks.add(node.block);
    const term = terms.get(node.block);
    if (term.kind === 'return') continue; // includes real throws and region sinks
    const next = resolve(node.next);
    if (term.kind === 'goto' || term.kind === 'fall') edge(next, term.target);
    else if (term.kind === 'cond') {
      if (next?.kind !== 'cond' || next.block !== node.block) { valid = false; break; }
      edge(next.taken, term.taken); edge(next.fall, term.fall);
    } else if (term.kind === 'switch') {
      if (next?.kind !== 'switch' || next.block !== node.block ||
          next.cases.length !== term.cases.length) { valid = false; break; }
      term.cases.forEach((item, index) => {
        if (next.cases[index].key !== item.key) valid = false;
        edge(next.cases[index].target, item.target);
      });
      if (term.default == null) { if (next.default != null) valid = false; }
      else edge(next.default, term.default);
    } else valid = false;
  }
  // Also require each source-reachable block. A surviving sibling branch must
  // not conceal a deleted sink, return, or an entire component entry.
  const expected = new Set(), queue = [flow.entry];
  while (queue.length && valid) {
    const block = queue.pop();
    if (expected.has(block)) continue;
    expected.add(block);
    const term = terms.get(block);
    if (!term) { valid = false; break; }
    switch (term.kind) {
      case 'return': break;
      case 'goto': case 'fall': queue.push(term.target); break;
      case 'cond': queue.push(term.taken, term.fall); break;
      case 'switch':
        for (const item of term.cases) queue.push(item.target);
        if (term.default != null) queue.push(term.default);
        break;
      default: valid = false;
    }
  }
  return valid && [...expected].every(block => seenBlocks.has(block));
}

module.exports = {verifyStructuredFlow};
