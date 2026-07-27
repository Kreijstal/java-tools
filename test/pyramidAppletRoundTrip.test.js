'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('tape');
const { decompileClassBytes } = require('../src/decompiler/cfr');
const { compileJavaSource } = require('../src/java-frontend/compiler');
const { assembleJasminBytes } = require('../src/utils/jasminAssembly');

test('minimal compiler accepts decompiled PyramidApplet array and support-field access', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyramid-roundtrip-'));
  try {
    const sourcePath = path.join(__dirname, '..', 'sources', 'PyramidApplet.java');
    const javac = spawnSync('javac', [
      '-source', '8',
      '-target', '8',
      '-d', tempDir,
      sourcePath,
    ], { encoding: 'utf8' });
    t.equal(javac.status, 0, `PyramidApplet fixture compiles: ${javac.stderr}`);
    if (javac.status !== 0) {
      t.end();
      return;
    }

    const original = new Uint8Array(
      fs.readFileSync(path.join(tempDir, 'PyramidApplet.class')),
    );
    const decompiled = decompileClassBytes(original, {
      allowFallback: true,
      preserveFieldNames: true,
    });
    t.match(
      decompiled,
      /var\d+\s*=\s*var\d+\.indices\[var\d+\]/,
      'decompiler emits the previously unsupported support-field array load',
    );
    t.notOk(
      /\.field_(?:indices|color|depth)\b/.test(decompiled),
      'legal nested-class field names retain their binary linkage names',
    );

    const result = compileJavaSource(decompiled, { sourceLevel: '8' });
    t.equal(result.bytecodeIr.status, 'complete', 'decompiled source lowers completely');
    t.equal(result.classes[0].internalName, 'PyramidApplet', 'outer applet is emitted');
    t.match(
      result.classes[0].jasmin,
      /getfield Field PyramidApplet\$Face indices \[I/,
      'rebuilt outer class still links to the original nested class field',
    );
    const rebuilt = assembleJasminBytes(result.classes[0].jasmin);
    t.ok(rebuilt.length > 0, 'rebuilt class assembles into class-file bytes');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('frontend-produced PyramidApplet bytecode decompiles back to readable source shapes', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sources', 'PyramidApplet.java'), 'utf8');
  const compiled = compileJavaSource(source, { sourceLevel: '8' });
  const outer = compiled.classes.find((item) => item.internalName === 'PyramidApplet');
  const outerIr = compiled.bytecodeIr.classes.find((item) => item.internalName === 'PyramidApplet');

  t.ok(outer, 'outer applet class is compiled');
  t.match(outer.jasmin, /\.localvariabletable/, 'compiler preserves source local-variable metadata');
  t.match(outer.jasmin, /\.constantvalue 10\.0/, 'compile-time final fields use ConstantValue metadata');
  t.notOk(
    outerIr.methods.some((method) => method.name === '<clinit>'),
    'literal static finals do not create a redundant class initializer',
  );

  const decompiled = decompileClassBytes(assembleJasminBytes(outer.jasmin), {
    allowFallback: true,
    preserveFieldNames: true,
  });
  t.match(decompiled, /double\[\]\[\] vertices = /, 'reused reference slots recover their ranged debug names');
  t.match(decompiled, /for \(double x = -GRID_SIZE; x <= GRID_SIZE;/, 'floating-point counting loops reconstruct as for loops');
  t.match(
    decompiled,
    /if \(v1\[2\] < near && v2\[2\] < near\)/,
    'short-circuit AND guards remain structured',
  );
  t.match(
    decompiled,
    /backBuffer == null \|\| this\.backBuffer\.getWidth/,
    'nested short-circuit OR guards remain structured',
  );
  t.notOk(/\bstackIn_|\bvar\d+\b|^\s+L\d+:/m.test(decompiled), 'compiler artifacts do not leak into reconstructed source');
  t.end();
});
