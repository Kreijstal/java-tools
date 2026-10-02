'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {treeToStatements, emitStatements} = require('../src/decompiler/javaAstEmitter');
const {printTree} = require('../src/decompiler/structurer');

const seq = (...body) => ({t: 'seq', body});
const straight = block => ({t: 'straight', block});
const jump = (t, label) => ({t, label});
function candidate(exitTree, trailing = false) {
  return {t: 'loop', label: 'Outer', body: seq(straight(0), {
    t: 'if', block: 0, then: trailing ? seq() : exitTree,
    els: seq(straight(2), jump('continue', 'Outer')),
  }, ...(trailing ? [exitTree] : []))};
}
const render = {
  straight: block => ({0: [], 1: ["trace.append('i'); count++;"],
    2: ["trace.append('o'); if (++count > limit + 10) return count+\":\"+trace;"],
    3: ["trace.append('t'); if ((count & 1) == 0) throw new IllegalArgumentException();"],
    4: ['return count+":"+trace;'], 5: ["trace.append('c');"]}[block]),
  cond: () => 'count < limit',
  condInverted: () => 'count >= limit',
  blockTerminates: block => block === 4,
};
const emitted = tree => emitStatements(treeToStatements(tree, render));

for (const kind of ['loop', 'block']) {
  test(`a break consumed by an inner ${kind} cannot justify rotating an outer exit`, () => {
    const exit = {t: kind, label: 'Inner', body: seq(straight(1), jump('break', 'Inner'))};
    assert.match(emitted(candidate(exit)), /Outer: while \(true\)/);
  });
}

test('a conditional break from an inner loop still allows normal completion', () => {
  const exit = {t: 'loop', label: 'Inner', body: seq(straight(1), {
    t: 'if', block: 0, then: jump('break', 'Inner'), els: jump('continue', 'Inner'),
  })};
  assert.match(emitted(candidate(exit)), /Outer: while \(true\)/);
});

test('normally completing trailing statements remain inside the outer loop', () => {
  const exit = {t: 'loop', label: 'Inner', body: seq(straight(1), jump('break', 'Inner'))};
  assert.match(emitted(candidate(exit, true)), /Outer: while \(true\)/);
});

test('breaks in catch and synchronized bodies stay bound to their inner loop', () => {
  for (const guarded of [
    {t: 'try', body: straight(3), catches: [{types: ['IllegalArgumentException'],
      varName: 'error', body: jump('break', 'Inner')}]},
    {t: 'synchronized', lockLocal: 0, body: jump('break', 'Inner')},
  ]) {
    const exit = {t: 'loop', label: 'Inner', body: seq(straight(1), guarded)};
    assert.match(emitted(candidate(exit)), /Outer: while \(true\)/);
  }
});

test('real returns and loops without an internal break still permit rotation', () => {
  for (const exit of [straight(4),
    {t: 'loop', label: 'Inner', body: seq(straight(4), jump('continue', 'Inner'))},
    {t: 'block', label: 'Inner', body: jump('break', 'Enclosing')},
  ]) assert.match(emitted({t: 'block', label: 'Enclosing', body: candidate(exit)}),
    /Outer: while \(count >= limit\)/);
});

function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const fds = files.map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...fds], timeout: 15000,
      env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'}});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally { fds.forEach(fd => fs.closeSync(fd)); }
}

test('emitted nested-loop and protected exits match native Java effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-loop-exits-'));
  try {
    const variants = [
      {tree: seq(straight(1), jump('break', 'Inner')),
        source: "trace.append('i'); count++; break inner;"},
      {tree: seq(straight(1), {t: 'try', body: straight(3), catches: [
        {types: ['IllegalArgumentException'], varName: 'error',
          body: seq(straight(5), jump('break', 'Inner'))},
      ]}, jump('break', 'Inner')),
        source: `trace.append('i'); count++; try {
          trace.append('t'); if ((count & 1) == 0) throw new IllegalArgumentException(); }
          catch (IllegalArgumentException error) { trace.append('c'); break inner; } break inner;`},
      {tree: {t: 'synchronized', lockLocal: 0,
        body: seq(straight(1), jump('break', 'Inner'))},
        source: "synchronized (lock0) { trace.append('i'); count++; break inner; }"},
      {tree: seq(straight(1), jump('break', 'Inner')), trailing: true,
        source: "trace.append('i'); count++; break inner;"},
    ];
    for (const [index, variant] of variants.entries()) {
      const native = `outer: while (true) { if (count < limit) {
        inner: while (true) { ${variant.source} }
      } else { trace.append('o'); if (++count > limit + 10) return count+":"+trace;
        continue outer; } }`;
      const rebuilt = printTree(candidate({t: 'loop', label: 'Inner', body: variant.tree},
        variant.trailing), render);
      const methods = {original: native, rebuilt};
      const source = `public class LoopExit${index} {
        ${Object.entries(methods).map(([name, body]) => `static String ${name}(int limit) {
          int count = 0; StringBuilder trace = new StringBuilder();
          Object lock0 = new Object(); ${body} }`).join('\n')}
        public static void main(String[] args) {
          for (int limit = -5; limit <= 100; limit++) {
            String expected = original(limit), actual = rebuilt(limit);
            if (!expected.equals(actual)) throw new AssertionError(limit+":"+expected+":"+actual);
            System.out.println(limit+":"+actual);
          }
        }
      }`;
      const javaFile = path.join(temporary, `LoopExit${index}.java`);
      fs.writeFileSync(javaFile, source);
      run('javac', ['--release', '8', '-d', temporary, javaFile], temporary);
      assert.equal(run('java', ['-cp', temporary, `LoopExit${index}`], temporary)
        .trim().split('\n').length, 106);
    }
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});
