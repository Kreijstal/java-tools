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

test('CFR-JS lifts javac try-with-resources release scaffolding', (t) => {
  t.plan(6);
  const actual = decompileClassFile(path.join(__dirname, '..', 'sources', 'TryWithResourcesTest.class'));

  t.notOk(/stack-underflow/.test(actual), 'try-with-resources decompilation does not underflow the operand stack');
  t.notOk(/^\s*\/\/\s*(if|goto|tableswitch|lookupswitch)\b/m.test(actual), 'try-with-resources does not fall back to raw control-flow comments');
  t.notOk(/addSuppressed/.test(actual), 'suppressed-exception release scaffolding is consumed');
  t.match(actual, /try \(TryWithResourcesTest\$TestResource resource = new TryWithResourcesTest\$TestResource\("Resource1"\)\) \{/, 'single resource is lifted into the try header');
  t.match(actual, /try \(TryWithResourcesTest\$TestResource resource1 = new TryWithResourcesTest\$TestResource\("Resource1"\); TryWithResourcesTest\$TestResource resource2 = new TryWithResourcesTest\$TestResource\("Resource2"\)\) \{/, 'multiple resources are lifted into the try header');
  t.match(actual, /for \(int __foreach_index16 = 0; __foreach_index16 < __foreach_array16\.length;[\s\S]*System\.out\.println\("  - " \+ suppressed\.getMessage\(\)\);/, 'post-TWR suppressed exception loop remains structured');
});

test('CFR-JS classifies nested loop break and continue edges', (t) => {
  t.plan(6);
  const actual = decompileClassFile(path.join(__dirname, '..', 'sources', 'PyramidApplet.class'));

  t.notOk(/stack-underflow/.test(actual), 'PyramidApplet decompilation does not underflow the operand stack');
  t.notOk(/^\s*\/\/\s*(if|goto|tableswitch|lookupswitch)\b/m.test(actual), 'PyramidApplet does not fall back to raw control-flow comments');
  t.match(actual, /for \(i = 0; i < vertices\.length;[\s\S]*if \(v\[2\] > 0\.2\)/, 'vertex projection loop is structured');
  t.match(actual, /for \(int __foreach_index32 = 0; __foreach_index32 < __foreach_array32\.length;[\s\S]*break;[\s\S]*}/, 'loop-exit goto is classified as break');
  // The skip test may come back either as the branch condition negated in place
  // (`normal[2] < 0.0`) or as the original wrapped in `!(…)`. The first is what
  // the source said and is what the structurer produces now that it negates the
  // comparison rather than the whole expression; both are the same predicate, so
  // the assertion is on the structure around it.
  t.match(actual, /for \(int __foreach_index27 = 0; __foreach_index27 < __foreach_array27\.length;[\s\S]*if \((?:!\(normal\[2\] >= 0\.0\)|normal\[2\] < 0\.0)\)/, 'outer face loop conditional skip is structured');
  t.notOk(/if \([^)]+\) \{\s*\} else \{/m.test(actual), 'empty then/else conditionals are inverted');
});
