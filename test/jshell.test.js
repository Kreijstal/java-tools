'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const test = require('tape');
const {
  candidateKinds,
  classifyMember,
  sourceForCandidate,
} = require('../src/jshell/JShellSession');
const { snippetComplete } = require('../scripts/jshell');

const CLI = path.join(__dirname, '..', 'scripts', 'jshell.js');

function runShell(input, args = []) {
  return spawnSync(process.execPath, [CLI, '--no-jit', ...args], {
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      JVM_DISABLE_AUDIO: '1',
    },
  });
}

test('JShell snippet classifier recognizes persistent members', (t) => {
  t.deepEqual(
    classifyMember('int answer = 42;', []),
    { kind: 'variable', name: 'answer' },
  );
  t.deepEqual(
    classifyMember('int twice(int value) { return value * 2; }', []),
    { kind: 'method', name: 'twice' },
  );
  t.deepEqual(
    classifyMember('class Point { int x; }', []),
    { kind: 'type', name: 'Point' },
  );
  t.equal(classifyMember('answer += 1;', []), null,
    'ordinary statements are not mistaken for class members');
  t.equal(classifyMember('twice(answer)', []), null,
    'method calls are not mistaken for declarations');
  t.equal(classifyMember('Example.answer = 1;', []), null,
    'qualified assignments are not mistaken for fields');
  t.end();
});

test('JShell source generation chains snippet classes', (t) => {
  const candidate = candidateKinds('int answer = 42;', [])[0];
  const source = sourceForCandidate(
    'JShellSnippet2',
    'JShellSnippet1',
    ['import java.util.*;'],
    candidate,
  );
  t.match(source, /import java\.util\.\*;/);
  t.match(source, /class JShellSnippet2 extends JShellSnippet1/);
  t.match(source, /public static int answer = 42;/);
  t.end();
});

test('JShell accepts declarations without a trailing semicolon', (t) => {
  const candidate = candidateKinds('int answer = 42', [])[0];
  t.equal(candidate.kind, 'variable');
  t.match(candidate.body, /int answer = 42;/);
  t.end();
});

test('JShell multiline completion ignores delimiters in strings and comments', (t) => {
  t.equal(snippetComplete('int twice(int x) {'), false);
  t.equal(snippetComplete('int twice(int x) {\\n return x * 2;\\n}'), true);
  t.equal(snippetComplete('System.out.println(\"{\");'), true);
  t.equal(snippetComplete('/* { */ int x = 1;'), true);
  t.end();
});

test('JShell CLI retains variables, mutations, and methods across snippets', (t) => {
  const result = runShell([
    'int value = 7;',
    'value',
    'value += 5;',
    'int twice(int input) { return input * 2; }',
    'twice(value)',
    '/vars',
    '/methods',
    '/exit',
    '',
  ].join('\n'));

  t.equal(result.status, 0, result.stderr);
  t.match(result.stdout, /\|  created variable value/);
  t.match(result.stdout, /(?:^|\n)7\n/, 'an expression reads the inherited field');
  t.match(result.stdout, /(?:^|\n)24\n/, 'a method sees the mutated field value');
  t.match(result.stdout, /\|  created method twice/);
  t.match(result.stdout, /int value = 7;/);
  t.match(result.stdout, /int twice\(int input\)/);
  t.end();
});

test('JShell CLI supports imports and reset', (t) => {
  const result = runShell([
    'import java.util.*',
    '/imports',
    '/reset',
    '/list',
    '/exit',
    '',
  ].join('\n'));

  t.equal(result.status, 0, result.stderr);
  t.match(result.stdout, /\|  imported java\.util\.\*/);
  t.match(result.stdout, /1 : import java\.util\.\*;/);
  t.match(result.stdout, /\|  reset/);
  t.match(result.stdout, /\|  \(none\)/);
  t.end();
});
