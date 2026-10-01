'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {decompileClassFile, assertNoFallback, _internals: {printCfgStateMachine}} = require('../src/decompiler/cfr');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');

function run(command, args, directory) {
  const output = path.join(directory, 'stdout'), error = path.join(directory, 'stderr');
  const descriptors = [output, error].map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...descriptors]});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(error, 'utf8'));
    return fs.readFileSync(output, 'utf8');
  } finally { descriptors.forEach(fd => fs.closeSync(fd)); }
}

function machine(bodies, terms, handlers = [], conditions = {}) {
  const cfg = {entry: 0, blocks: bodies.map((body, id) => ({id, insns: [id]})), term: terms};
  const code = bodies.map((body, id) => ({pc: id * 10}));
  return coalesceLinearStates => {
    const declarations = ['int result = 0;'];
    const stats = {};
    const source = printCfgStateMachine(cfg,
      {cond: id => conditions[id] ?? 'input > 0', switchValue: () => 'input'},
      id => ({lines: bodies[id]}), code, handlers, declarations, 'int',
      {coalesceLinearStates, stats});
    const body = [...declarations, source].join('\n');
    assertNoFallback(body);
    return {body, stats};
  };
}

function behavior(render, expected, after) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-state-chain-'));
  try {
    for (const enabled of [false, true]) {
      const directory = path.join(temporary, String(enabled));
      fs.mkdirSync(directory);
      const rendered = render(enabled);
      if (enabled) assert.equal(rendered.stats.statesAfter, after);
      const calls = expected.map(([input]) => `System.out.println(compute(${input}));`).join('\n');
      fs.writeFileSync(path.join(directory, 'MachineFixture.java'),
        `public class MachineFixture {
          static int shadowed = 9;
          static int compute(int input) { ${rendered.body} }
          public static void main(String[] args) { ${calls} }
        }`);
      run('javac', ['--release', '8', '-d', directory, path.join(directory, 'MachineFixture.java')], directory);
      assert.equal(run('java', ['-cp', directory, 'MachineFixture'], directory),
        expected.map(([, value]) => value + '\n').join(''));
    }
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
}

test('linear states coalesce while preserving separate scopes for duplicate local names', () => {
  const render = machine([
    ['int temporary = 3;', 'result += temporary;'],
    ['int temporary = 5;', 'result *= temporary;'], ['return result;'],
  ], [{kind: 'goto', target: 1}, {kind: 'fall', target: 2}, {kind: 'return'}]);
  assert.equal(render(false).stats.statesAfter, 3);
  behavior(render, [[0, 15]], 1);
});

test('join targets retain alternate entries and a conditional tail remains conditional', () => {
  const join = machine([
    [], ['result = 7;'], ['result = 9;'], ['return result;'],
  ], [{kind: 'cond', taken: 1, fall: 2}, {kind: 'goto', target: 3},
    {kind: 'goto', target: 3}, {kind: 'return'}]);
  assert.match(join(true).body, /case 3:/, 'shared join keeps its own state');
  behavior(join, [[0, 9], [1, 7]], 2);
  const tail = machine([
    ['result = 10;'], ['result++;'], ['return result;'], ['return -result;'],
  ], [{kind: 'goto', target: 1}, {kind: 'cond', taken: 2, fall: 3},
    {kind: 'return'}, {kind: 'return'}]);
  behavior(tail, [[0, -11], [1, 11]], 1);
});

test('loops retain their entry and side-effect order', () => {
  const render = machine([
    ['result = 0;'], [], ['result++;'], ['return result;'],
  ], [{kind: 'goto', target: 1}, {kind: 'cond', taken: 2, fall: 3},
    {kind: 'goto', target: 1}, {kind: 'return'}], [], {1: 'result < input'});
  assert.match(render(true).body, /case 1:/, 'loop header remains dispatchable');
  behavior(render, [[-1, 0], [0, 0], [4, 4]], 2);
});

test('switch entries remain dispatchable after their linear tails coalesce', () => {
  const render = machine([
    [], ['result = 4;'], ['result = 8;'], ['return result + 1;'], ['return result + 2;'],
  ], [{kind: 'switch', cases: [{key: 1, target: 1}], default: 2},
    {kind: 'goto', target: 3}, {kind: 'goto', target: 4}, {kind: 'return'}, {kind: 'return'}]);
  behavior(render, [[0, 10], [1, 5], [2, 10]], 1);
});

test('branch inlining refuses parent-local scope changes that would silently rebind a field', () => {
  const render = machine([
    ['int shadowed = 3;', 'result += shadowed;'], ['return shadowed;'], ['return result;'],
  ], [{kind: 'cond', taken: 1, fall: 2}, {kind: 'return'}, {kind: 'return'}]);
  behavior(render, [[0, 3], [1, 9]], 3);
});

test('repeated switch targets retain their shared entry rather than being absorbed twice', () => {
  const render = machine([[], ['return 5;'], ['return 10;']],
    [{kind: 'switch', cases: [{key: 1, target: 1}, {key: 2, target: 1}], default: 2},
      {kind: 'return'}, {kind: 'return'}]);
  behavior(render, [[0, 10], [1, 5], [2, 5]], 2);
});

test('equivalent handlers can coalesce; distinct handler regions cannot', () => {
  const bodies = [
    ['result++;', 'if (input == 0) throw new ArithmeticException();'],
    ['result += 10;', 'if (input == 1) throw new ArithmeticException();'],
    ['return result;'], ['return 100 + result;'], ['return 200 + result;'],
  ];
  const terms = [{kind: 'goto', target: 1}, {kind: 'goto', target: 2},
    {kind: 'return'}, {kind: 'return'}, {kind: 'return'}];
  const same = machine(bodies, terms,
    [{start_pc: 0, end_pc: 20, handler_pc: 30, catch_type: 'java/lang/ArithmeticException'}]);
  behavior(same, [[0, 101], [1, 111], [2, 11]], 3);
  const distinct = machine(bodies, terms, [
    {start_pc: 0, end_pc: 10, handler_pc: 30, catch_type: 'java/lang/ArithmeticException'},
    {start_pc: 10, end_pc: 20, handler_pc: 40, catch_type: 'java/lang/RuntimeException'},
  ]);
  behavior(distinct, [[0, 101], [1, 211], [2, 11]], 5);
});

test('exception handler entries cannot be absorbed through a normal predecessor', () => {
  const render = machine([
    ['if (input == 0) throw new ArithmeticException();'], ['result = 7;'], ['return result;'],
  ], [{kind: 'goto', target: 1}, {kind: 'goto', target: 2}, {kind: 'return'}],
  [{start_pc: 0, end_pc: 10, handler_pc: 20, catch_type: 'java/lang/ArithmeticException'}]);
  behavior(render, [[0, 0], [1, 7]], 3);
});

test('combined case weight is bounded for oversized-method partitioning', () => {
  const bodies = Array.from({length: 24}, () => Array(30).fill('result++;'));
  const terms = bodies.map((body, index) => ({kind: 'goto', target: index + 1}));
  bodies.push(['return result;']); terms.push({kind: 'return'});
  const render = machine(bodies, terms);
  const merged = render(true);
  assert.ok(merged.stats.statesAfter > 1 && merged.stats.statesAfter < bodies.length);
  behavior(render, [[0, 720]], merged.stats.statesAfter);
});

test('native original and forced fallback variants agree on loops, switch, exceptions and finally', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-state-native-'));
  const source = `public class NativeStateFixture {
    static int effects;
    static int compute(int input) {
      effects = 0;
      int sum = 0;
      for (int i = 0; i < 4; i++) {
        if ((input + i) % 2 == 0) { effects += 3; sum += i; }
        else { effects += 5; sum -= i; }
      }
      try { sum += 24 / (input - 1); effects++; }
      catch (ArithmeticException e) { effects += 11; }
      finally { effects += 7; }
      switch (input) { case -1: sum -= 5; break; case 0: sum += 9; break; default: sum += 2; }
      return sum + effects;
    }
    public static void main(String[] args) {
      for (int i = -2; i <= 3; i++) System.out.println(compute(i) + ":" + effects);
    }
  }`;
  const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const original = path.join(temporary, 'original');
    fs.mkdirSync(original);
    const file = path.join(original, 'NativeStateFixture.java');
    fs.writeFileSync(file, source);
    run('javac', ['--release', '8', '-d', original, file], original);
    const expected = run('java', ['-cp', original, 'NativeStateFixture'], original);
    process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
    for (const enabled of [false, true]) {
      const directory = path.join(temporary, String(enabled));
      fs.mkdirSync(directory);
      const generated = decompileClassFile(path.join(original, 'NativeStateFixture.class'),
        {coalesceStateMachineChains: enabled});
      const java = path.join(directory, 'NativeStateFixture.java');
      fs.writeFileSync(java, generated);
      run('javac', ['--release', '8', '-d', directory, java], directory);
      assert.equal(run('java', ['-cp', directory, 'NativeStateFixture'], directory), expected);
    }
  } finally {
    if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('oversized partitioned fallbacks retain method-level state reduction diagnostics', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-state-diagnostics-'));
  try {
    const file = path.join(temporary, 'PartitionDiagnostics.class');
    assembleJasminSource(`.version 52 0
      .class public super PartitionDiagnostics
      .super java/lang/Object
      .method public static huge : ()V
        .code stack 0 locals 0
        ${Array(5001).fill('nop').join('\n')}
        goto Lend
        Lend: return
        .end code
      .end method
      .end class
`, file);
    const diagnostics = [];
    const source = decompileClassFile(file, {diagnostics});
    assert.match(source, /class \$CfrPartitionedState/);
    const report = diagnostics.find(item => item.methodName === 'huge');
    assert.ok(report, 'partitioned methods must not bypass fallback reporting');
    assert.equal(report.dispatchStatesBefore, 1);
    assert.equal(report.dispatchStatesAfter, 1);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});
