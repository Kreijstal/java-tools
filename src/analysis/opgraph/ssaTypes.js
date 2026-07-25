'use strict';

// Value-kind lattice for the shared SSA IR. Kinds are JVM verification
// categories, not Java types: I (int-like: boolean/byte/char/short/int),
// J (long), F (float), D (double), A (reference), V (void, only as a return
// kind). CONFLICT marks a local-slot join whose incoming kinds disagree —
// legal in dead frame slots (javac reuses slots across disjoint live ranges)
// but never legal to load from.

const KIND_WIDTH = { I: 1, J: 2, F: 1, D: 2, A: 1, V: 0 };
const CONFLICT = 'X';

function kindWidth(kind) {
  const width = KIND_WIDTH[kind];
  return width === undefined ? 1 : width;
}

function isWideKind(kind) {
  return kind === 'J' || kind === 'D';
}

// Field or return descriptor -> kind. Array and object types are both A.
function kindFromDescriptor(descriptor) {
  if (typeof descriptor !== 'string' || descriptor.length === 0) return null;
  const c = descriptor[0];
  if (c === 'L' || c === '[') return 'A';
  if (c === 'J') return 'J';
  if (c === 'F') return 'F';
  if (c === 'D') return 'D';
  if (c === 'V') return 'V';
  if (c === 'B' || c === 'C' || c === 'S' || c === 'Z' || c === 'I') return 'I';
  return null;
}

// Return kind of a method descriptor "(...)R".
function returnKindFromMethodDescriptor(descriptor) {
  if (typeof descriptor !== 'string') return null;
  const close = descriptor.lastIndexOf(')');
  if (close < 0) return null;
  return kindFromDescriptor(descriptor.slice(close + 1));
}

// Parameter kinds of a method descriptor, in order (no receiver).
function paramKindsFromMethodDescriptor(descriptor) {
  if (typeof descriptor !== 'string' || descriptor[0] !== '(') return null;
  const kinds = [];
  let i = 1;
  while (i < descriptor.length && descriptor[i] !== ')') {
    const start = i;
    while (descriptor[i] === '[') i += 1;
    if (descriptor[i] === 'L') {
      const end = descriptor.indexOf(';', i);
      if (end < 0) return null;
      i = end + 1;
    } else {
      i += 1;
    }
    kinds.push(kindFromDescriptor(descriptor.slice(start, i)));
  }
  if (descriptor[i] !== ')') return null;
  if (kinds.some((kind) => kind === null || kind === 'V')) return null;
  return kinds;
}

// Join two kinds at a control-flow merge. Equal kinds join to themselves;
// anything else is CONFLICT. null (unknown, e.g. an undef arm) is the
// identity so a slot defined on only some paths keeps its defined kind.
function mergeKind(left, right) {
  if (left === null || left === undefined) return right ?? null;
  if (right === null || right === undefined) return left;
  if (left === right) return left;
  return CONFLICT;
}

module.exports = {
  CONFLICT,
  kindWidth,
  isWideKind,
  kindFromDescriptor,
  returnKindFromMethodDescriptor,
  paramKindsFromMethodDescriptor,
  mergeKind,
};
