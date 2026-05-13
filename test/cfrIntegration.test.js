'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');

const projectRoot = path.join(__dirname, '..');

const VERY_SIMPLE_JASMIN = `.version 52 0
.class public super VerySimple
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0: aload_0
L1: invokespecial Method java/lang/Object <init> ()V
L2: return
    .end code
.end method

.method public static main : ([Ljava/lang/String;)V
    .code stack 2 locals 4
L0: bipush 9
L2: istore_1
L3: iconst_4
L4: istore_2
L5: iload_1
L6: iload_2
L7: isub
L8: istore_3
L9: getstatic Field java/lang/System out Ljava/io/PrintStream;
L12: iload_3
L13: invokevirtual Method java/io/PrintStream println (I)V
L16: return
L17:
        .localvariabletable
            0 is args [Ljava/lang/String; from L0 to L17
        .end localvariabletable
    .end code
.end method
.sourcefile "VerySimple.java"
.end class
`;

function node(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function combined(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assembleVerySimple(tempDir) {
  const classPath = path.join(tempDir, 'VerySimple.class');
  assembleJasminSource(VERY_SIMPLE_JASMIN, classPath);
  return classPath;
}

test('CFR-JS reports its native JavaScript version', (t) => {
  const result = node(['scripts/runCfr.js', '--version']);
  t.equal(result.status, 0, 'version command exits successfully');
  t.match(combined(result), /CFR-JS 0\.4\.0/, 'reports the JavaScript decompiler build');
  t.end();
});

test('CFR-JS decompiles a simple class without the CFR jar', (t) => {
  withTempDir('cfr-js-simple-', (tempDir) => {
    const classPath = assembleVerySimple(tempDir);
    const result = node(['scripts/runCfr.js', classPath]);
    const output = combined(result);

    t.equal(result.status, 0, 'decompilation exits successfully');
    t.match(output, /public class VerySimple/, 'class declaration is emitted');
    t.match(output, /public static void main\(String\[\] args\)/, 'main signature is emitted');
    t.match(output, /int\s+var\d+\s*=\s*var\d+\s*-\s*var\d+;/, 'integer local inference survives decompilation');
    t.match(output, /System\.out\.println\(var\d+\);/, 'println call is emitted as Java source');
    t.notOk(/Exception decompiling|Bad local class Type|Could not load the following classes/.test(output), 'no CFR failure marker is emitted');
  });
  t.end();
});

test('CFR-JS writes outputdir Java sources', (t) => {
  withTempDir('cfr-js-simple-', (classTempDir) => {
    const classPath = assembleVerySimple(classTempDir);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-js-out-'));
    try {
      const result = node(['scripts/runCfr.js', '--outputdir', outputDir, classPath]);
      t.equal(result.status, 0, 'outputdir decompilation exits successfully');
      const outPath = path.join(outputDir, 'VerySimple.java');
      t.ok(fs.existsSync(outPath), 'VerySimple.java is written');
      const source = fs.readFileSync(outPath, 'utf8');
      t.match(source, /public class VerySimple/, 'written source contains the class declaration');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
  t.end();
});
