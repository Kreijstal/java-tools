'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { collectExceptionMetadata } = require('../src/exceptionMetadata');

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('collectExceptionMetadata aggregates declared and implicit exceptions', (t) => {
  const ast = {
    classes: [
      {
        className: 'Foo',
        items: [
          {
            type: 'method',
            method: {
              name: 'bar',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { instruction: { op: 'getfield' } },
                      { instruction: 'return' },
                    ],
                  },
                },
                {
                  type: 'exceptions',
                  exceptions: ['java/io/IOException'],
                },
              ],
            },
          },
          {
            type: 'method',
            method: {
              name: 'baz',
              descriptor: '()V',
              attributes: [],
            },
          },
        ],
      },
    ],
  };
  const metadata = collectExceptionMetadata(ast);
  t.equal(metadata.length, 2, 'should return entries for each method');
  const barEntry = metadata.find((entry) => entry.methodName === 'bar');
  t.deepEqual(barEntry.declared, ['java/io/IOException'], 'declared exceptions preserved');
  t.deepEqual(
    barEntry.implicit,
    ['java/lang/NullPointerException'],
    'implicit exceptions include opcode-derived values',
  );
  const bazEntry = metadata.find((entry) => entry.methodName === 'baz');
  t.deepEqual(bazEntry.declared, [], 'methods without throws have empty declared list');
  t.deepEqual(bazEntry.implicit, [], 'methods without relevant opcodes have empty implicit list');
  t.end();
});

test('jvm-cli throws command emits JSON when requested', (t) => {
  withTempDir('throws-cli-', (tempDir) => {
    const source = `
.version 55 0
.class public TestThrows
.super java/lang/Object

.field private value I

.method public <init> : ()V
    .code stack 1 locals 1
L0:    aload_0
L1:    invokespecial Method java/lang/Object <init> ()V
L4:    return
    .end code
.end method

.method public example : ()V
    .code stack 1 locals 1
L0:    aload_0
L1:    getfield Field TestThrows value I
L4:    return
    .end code
    .exceptions java/io/IOException
.end method
.end class
`.trim();
    const inputPath = path.join(tempDir, 'TestThrows.j');
    fs.writeFileSync(inputPath, source, 'utf8');
    const cliPath = path.join(__dirname, '..', 'scripts', 'jvm-cli.js');
    const output = execFileSync('node', [cliPath, 'throws', inputPath, '--json'], {
      encoding: 'utf8',
    });
    const metadata = JSON.parse(output);
    t.ok(Array.isArray(metadata), 'CLI should emit JSON array');
    const entry = metadata.find((item) => item.methodName === 'example');
    t.ok(entry, 'example method should be present');
    t.deepEqual(entry.declared, ['java/io/IOException'], 'declared exceptions serialized');
    t.ok(
      entry.implicit.includes('java/lang/NullPointerException'),
      'implicit opcode exceptions serialized',
    );
    t.end();
  });
});
