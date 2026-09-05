const test = require('tape');
const {
  unboundGeneratedSsaIdentifiers,
} = require('../src/jit/JvmSsaBlockRenderer');

// The generated-body verifier is the net under two codegen defects that only
// showed up as a ReferenceError on a cold path, minutes into a run and on
// whichever guest thread reached it first:
//
//   * a restoring body naming SSA values minted by a *different* render of
//     the same method, because the materialization snapshot was keyed by
//     bytecode pc and the last render to touch that pc won; and
//   * an invariant positional receiver guard reading `localN` for a slot the
//     body never declared, because the slot is provably unassigned and the
//     rendered tree kept its value under an SSA name instead.
//
// Neither name is an `ssaValue`-prefixed one in the second case, so the
// candidate predicate and the externally bound names both matter.

test('the generated-body verifier accepts a caller-supplied name predicate',
  (t) => {
    const source = [
      'let ssaValue0 = local0;',
      'ssaValue0 = argument0 + local1;',
      'let local1 = 2;',
    ].join('\n');
    t.deepEqual(unboundGeneratedSsaIdentifiers(source), [],
      'the default predicate looks only at ssaValue names');
    t.deepEqual(
      unboundGeneratedSsaIdentifiers(source,
        (name) => /^(ssa|local\d|argument\d)/.test(name)),
      ['argument0', 'local0'],
      'a predicate widens the check to JVM slot and argument names');
    t.deepEqual(
      unboundGeneratedSsaIdentifiers(source,
        (name) => /^(ssa|local\d|argument\d)/.test(name), ['argument0']),
      ['local0'],
      'a name the caller binds as a parameter or capture is not unbound');
    t.end();
  });

test('the verifier rejects a slot name no declaration binds', (t) => {
  // The shape of the invariant positional receiver guard: the fast-path
  // declaration reads the receiver slot by lexical name at the head of the
  // body, while only the slots the tree rendered are declared.
  const guard = [
    'let local1 = locals[1];',
    'const ssaInvariantPositionalRaw6 = ssaFastPositionalRawInvoke6 &&',
    '  local0 !== null && local0 !== undefined ? ssaFastPositionalRawInvoke6',
    '  : null;',
  ].join('\n');
  t.deepEqual(
    unboundGeneratedSsaIdentifiers(guard,
      (name) => /^(ssa|local\d)/.test(name), ['ssaFastPositionalRawInvoke6']),
    ['local0'],
    'a receiver slot read by the guard must be declared by the body');
  t.deepEqual(
    unboundGeneratedSsaIdentifiers(`let local0 = locals[0];\n${guard}`,
      (name) => /^(ssa|local\d)/.test(name), ['ssaFastPositionalRawInvoke6']),
    [], 'declaring the slot satisfies the guard');
  t.end();
});

test('the verifier rejects frame values from another render of the method',
  (t) => {
    // A restoring body materializes a cold frame from the slot values current
    // at that site. Values carried over from a different render of the same
    // method are names this body never declares.
    const body = [
      'let local0 = argument0;',
      'let ssaValue10 = local0 + 1;',
      'if (thread.status !== "runnable") {',
      '  helpers.materializeDirectFrame(3, plan, thread, 0, null,',
      '    [ssaValue10, ssaValue38128], 172, []);',
      '}',
    ].join('\n');
    t.deepEqual(
      unboundGeneratedSsaIdentifiers(body, null, ['argument0']),
      ['ssaValue38128'],
      'a frame value the body never produced is reported');
    t.end();
  });
