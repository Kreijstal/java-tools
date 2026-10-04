'use strict';

// Syntactic children of tree nodes. Attribution adds semantic properties
// (symbols, types, environments) that may form cycles, so walkers must only
// follow these keys.
const CHILD_KEYS = [
  'pkg', 'imports', 'types', 'module',
  'defs', 'decl', 'body', 'stats', 'init', 'step', 'cond', 'thenp', 'elsep', 'var', 'expr',
  'selector', 'cases', 'labels', 'guard', 'resources', 'catchers', 'param', 'finalizer', 'lock',
  'value', 'detail', 'lhs', 'rhs', 'arg', 'truepart', 'falsepart', 'selected', 'meth', 'args',
  'encl', 'elems', 'dims', 'indexed', 'index', 'params', 'pattern', 'pat', 'nested',
];

function forEachChild(n, fn) {
  for (const k of CHILD_KEYS) {
    const v = n[k];
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && x.tag) fn(x); }
    else if (v.tag) fn(v);
  }
  if (n.tag === 'VarDecl' && n.enumConstant) {
    for (const a of n.enumConstant.args) fn(a);
    if (n.enumConstant.body) fn(n.enumConstant.body);
  }
}

module.exports = { forEachChild, CHILD_KEYS };
