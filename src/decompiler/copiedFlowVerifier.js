'use strict';

// Check the finite simulation relation supplied by a node splitter. Copies
// carry source block identities; the renderer uses those identities to retain
// the original actions/tests. Every outcome must project to its original edge.
// No sampled execution or reducibility assumption supplies evidence here.
function verifyCopiedFlow(source, entry, split) {
  if (!Array.isArray(source) || !source.length || !Number.isSafeInteger(entry)
      || entry < 0 || entry >= source.length || !split
      || !Array.isArray(split.terms) || !Array.isArray(split.origins)
      || split.terms.length < source.length
      || split.terms.length !== split.origins.length) return false;
  const {terms, origins} = split;
  for (let copy = 0; copy < terms.length; copy++) {
    const origin = origins[copy];
    if (!Number.isSafeInteger(origin) || origin < 0 || origin >= source.length
        || copy < source.length && origin !== copy) return false;
  }
  if (origins[entry] !== entry) return false;
  const edge = (copyTarget, sourceTarget) =>
    Number.isSafeInteger(copyTarget) && copyTarget >= 0 && copyTarget < terms.length
    && Number.isSafeInteger(sourceTarget) && sourceTarget >= 0 && sourceTarget < source.length
    && origins[copyTarget] === sourceTarget;
  for (let copy = 0; copy < terms.length; copy++) {
    const original = source[origins[copy]], candidate = terms[copy];
    if (!original || !candidate || candidate.kind !== original.kind) return false;
    switch (original.kind) {
      case 'return': break;
      case 'goto': case 'fall':
        if (!edge(candidate.target, original.target)) return false;
        break;
      case 'cond':
        if (!edge(candidate.taken, original.taken) || !edge(candidate.fall, original.fall)) return false;
        break;
      case 'switch':
        if (!Array.isArray(original.cases) || !Array.isArray(candidate.cases)
            || candidate.cases.length !== original.cases.length) return false;
        for (let i = 0; i < original.cases.length; i++) {
          const a = original.cases[i], b = candidate.cases[i];
          if (!a || !b || a.key !== b.key || !edge(b.target, a.target)) return false;
        }
        if (original.default == null) {if (candidate.default != null) return false;}
        else if (!edge(candidate.default, original.default)) return false;
        break;
      default: return false;
    }
  }
  return true;
}

module.exports = {verifyCopiedFlow};
