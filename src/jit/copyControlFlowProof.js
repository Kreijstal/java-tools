'use strict';

const opposite = {
  if_acmpeq: 'if_acmpne', if_acmpne: 'if_acmpeq',
  if_icmpeq: 'if_icmpne', if_icmpne: 'if_icmpeq',
  if_icmpge: 'if_icmplt', if_icmplt: 'if_icmpge',
  if_icmpgt: 'if_icmple', if_icmple: 'if_icmpgt',
};

// Bounded instruction-graph bisimulation. Only unconditional jumps disappear;
// every load, update, element effect and conditional must match. A conditional
// may be inverted if both successors are swapped. Many actual blocks may match
// one template block, admitting duplicated tails without trusting source names.
function equivalentCopyControlFlow(actual, expected) {
  if (!actual?.length || actual.length > 4096 || !expected?.length || expected.length > 4096) return false;
  let work = 0;
  const skip = (code, start) => {
    const seen = new Set(); let pc = start;
    while (Number.isInteger(pc) && pc >= 0 && pc < code.length) {
      if (++work > 131072) return -1;
      if (code[pc][0] !== 'goto') return pc;
      if (seen.has(pc)) return -1;
      seen.add(pc); pc = code[pc][1];
    }
    return -1;
  };
  const pending = [[0, 0]], seen = new Set();
  while (pending.length) {
    if (++work > 131072) return false;
    if (seen.size > 32768 || pending.length > 32768) return false;
    const [ap, ep] = pending.pop(), a = skip(actual, ap), e = skip(expected, ep);
    if (a < 0 || e < 0) return false;
    const pair = a * expected.length + e;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const left = actual[a], right = expected[e];
    if (opposite[right[0]]) {
      if (left.length !== 2 || right.length !== 2) return false;
      if (left[0] === right[0]) pending.push([left[1], right[1]], [a + 1, e + 1]);
      else if (left[0] === opposite[right[0]]) pending.push([left[1], e + 1], [a + 1, right[1]]);
      else return false;
    } else {
      if (left.length !== right.length || left.some((v, i) => v !== right[i])) return false;
      if (left[0] !== 'return') pending.push([a + 1, e + 1]);
    }
  }
  return true;
}

module.exports = {equivalentCopyControlFlow};
