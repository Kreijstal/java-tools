'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminFile } = require('../src/utils/jasminAssembly');
const { decompileClassFile } = require('../src/decompiler/cfr');

const fixtureRoot = path.join(__dirname, 'fixtures', 'cfr');
const jasminRoot = path.join(fixtureRoot, 'jasmin');
const expectedRoot = path.join(fixtureRoot, 'expected');

const exactCases = [
  'CondJumpTest2c.6',
  'CondJumpTest2c.10',
  'EnumTestEmpty.6',
  'EnumTestEmpty.13',
  'TypeArgTestCharIndex.8',
];

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assembleAndDecompile(fixtureName, tempDir) {
  const jasminPath = path.join(jasminRoot, `${fixtureName}.j`);
  const classPath = path.join(tempDir, `${fixtureName}.class`);
  assembleJasminFile(jasminPath, classPath);
  return decompileClassFile(classPath);
}

function readExpected(fixtureName) {
  return fs.readFileSync(path.join(expectedRoot, `${fixtureName}.expected.java`), 'utf8');
}

function normalizeJavaSource(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}();,=+*/<>!|&])\s*/g, '$1')
    .trim();
}

function assertNoFallbackArtifacts(t, source) {
  t.notOk(/stack-underflow/.test(source), 'decompilation does not underflow the operand stack');
  t.notOk(/^\s*\/\/\s*(if|goto|tableswitch|lookupswitch)\b/m.test(source), 'structured CFR fixture does not fall back to raw control-flow comments');
}

test('CFR-JS ports CFR decompilation fixture outputs', (t) => {
  t.plan(exactCases.length * 3);
  withTempDir('cfr-fixtures-', (tempDir) => {
    exactCases.forEach((fixtureName) => {
      const actual = assembleAndDecompile(fixtureName, tempDir);
      const expected = readExpected(fixtureName);
      assertNoFallbackArtifacts(t, actual);
      t.equal(
        normalizeJavaSource(actual),
        normalizeJavaSource(expected),
        `${fixtureName} matches the corresponding CFR expected source body`,
      );
    });
  });
});

test('CFR-JS ports CFR TryTest1 control-flow fixture features', (t) => {
  t.plan(9);
  withTempDir('cfr-try-', (tempDir) => {
    const actual = assembleAndDecompile('TryTest1.10', tempDir);
    const expected = readExpected('TryTest1.10');
    assertNoFallbackArtifacts(t, actual);

    t.ok(expected.includes('throw new NoSuchFieldException();'), 'ported expected fixture preserves the CFR throw shape');
    t.match(actual, /package org\.benf\.cfr\.tests;/, 'package declaration is emitted');
    t.match(actual, /public class TryTest1/, 'class declaration is emitted');
    t.match(actual, /public void test1\(\)/, 'method declaration is emitted');
    t.match(actual, /try \{[\s\S]*System\.out\.print\(3\);[\s\S]*throw new NoSuchFieldException\(\);[\s\S]*\} catch \(NoSuchFieldException noSuchFieldException\)/, 'try/catch body is reconstructed');
    t.match(actual, /System\.out\.print\("Finally!"\);/, 'catch body print is emitted');
    t.match(actual, /System\.out\.print\(5\);/, 'post-catch continuation is emitted');
  });
});
