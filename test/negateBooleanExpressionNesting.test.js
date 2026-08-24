'use strict';

// Regression: negating a boolean expression must never rewrite a comparison
// operator that is NESTED inside the expression (a call's argument list, an
// array index, a parenthesised subexpression).
//
// negateBooleanExpression matched /^(.+) (==|!=|...) (.+)$/ against the whole
// rendered string. The leading (.+) is greedy, so for a call expression it split
// on an operator inside the ARGUMENTS and flipped that instead of negating the
// call. reference workload hit this: negating
//   ((nm) x).a(a, b, c, stackIn_41_4 != 0, 2, param4)
// rewrote the argument to `== 0`, inverting the lobby list's skip-the-walk flag.
// The rows decoded, inserted, laid out and painted correctly and were then
// clipped to nothing, because the list never measured its content height.
// Confirmed against the 2022 gamepack: the untouched original renders the lobby
// names, a build carrying this inversion does not.

const test = require('tape');
const { _internals } = require('../src/decompiler/cfr');

const { negateBooleanExpression, isBracketBalanced } = _internals;

function boolExpr(code) {
  return { code, type: 'boolean', precedence: 60 };
}

test('negation does not rewrite a comparison nested in a call argument list', (t) => {
  const call = 'owner.a(one, two, three, flag != 0, 2, param4)';
  const negated = negateBooleanExpression(boolExpr(call)).code;
  t.equal(/flag == 0/.test(negated), false, 'the nested argument is left alone');
  t.match(negated, /flag != 0/, 'the argument keeps its original sense');
  t.match(negated, /^!/, 'the call itself is negated instead');
  t.end();
});

test('negation still inverts a genuine top-level comparison', (t) => {
  t.equal(negateBooleanExpression(boolExpr('a != 0')).code, 'a == 0');
  t.equal(negateBooleanExpression(boolExpr('x >= y')).code, 'x < y');
  t.equal(negateBooleanExpression(boolExpr('f(p) == g(q)')).code, 'f(p) != g(q)',
    'operands may contain calls as long as the operator is top level');
  t.equal(negateBooleanExpression(boolExpr('(a + b) <= (c + d)')).code, '(a + b) > (c + d)');
  t.end();
});

test('negation wraps when the only operator sits inside brackets', (t) => {
  t.equal(negateBooleanExpression(boolExpr('f(a == b)')).code, '!(f(a == b))');
  t.equal(negateBooleanExpression(boolExpr('arr[i != 0]')).code, '!(arr[i != 0])');
  t.end();
});

test('isBracketBalanced distinguishes top-level splits from nested ones', (t) => {
  t.ok(isBracketBalanced('a'), 'plain identifier');
  t.ok(isBracketBalanced('f(x)'), 'balanced call');
  t.ok(isBracketBalanced('(a + b)'), 'balanced parens');
  t.notOk(isBracketBalanced('f(a'), 'unclosed call is not top level');
  t.notOk(isBracketBalanced('a)'), 'stray close is not top level');
  t.notOk(isBracketBalanced('arr[i'), 'unclosed index is not top level');
  t.end();
});
