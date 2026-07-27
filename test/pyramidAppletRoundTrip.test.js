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
