'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { parseKrak2Assembly } = require('../src/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/convert_tree');

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withTempReturn(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function canonicalizeJasmin(text) {
  return withTempReturn('jasmin-format-', (tempDir) => {
    const ast = convertKrak2AstToClassAst(parseKrak2Assembly(text), { sourceText: text });
    const tempClass = path.join(tempDir, 'tmp.class');
    writeClassAstToClassFile(ast, tempClass);
    const classBytes = fs.readFileSync(tempClass);
    const parsed = getAST(new Uint8Array(classBytes));
    const classAst = convertJson(parsed.ast, parsed.constantPool);
    return classAst.classes.map((cls) => unparseDataStructures(cls, parsed.constantPool)).join('\n');
  });
}

function findCommentStart(line) {
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inDouble && ch === ';') {
      return i;
    }
  }
  return -1;
}

function stripComments(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const idx = findCommentStart(line);
      const code = idx >= 0 ? line.slice(0, idx) : line;
      return code.trimEnd();
    })
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

test('format command canonicalizes code while preserving comments', (t) => {
  withTempDir('jvm-cli-format-', (tempDir) => {
    const cliPath = path.join(__dirname, '..', 'scripts', 'jvm-cli.js');
    const inputPath = path.join(tempDir, 'Foo.j');
    const messySource = `
.version 55 0
; header comment
.class public super Foo
.super java/lang/Object

; comment before method
.method public static test : ()V
    .code stack 1 locals 1
L0:     return    ; tail comment
    .end code
.end method
; footer note
.end class
`.trim();
    fs.writeFileSync(inputPath, messySource, 'utf8');
    execFileSync('node', [cliPath, 'format', inputPath], { encoding: 'utf8' });
    const formatted = fs.readFileSync(inputPath, 'utf8');
    t.ok(formatted.includes('; header comment'), 'standalone comment should remain');
    t.ok(formatted.includes('; footer note'), 'footer comment should remain');
    t.ok(/return\s+; tail comment/.test(formatted), 'inline comment should remain attached to instruction');
    const canonical = canonicalizeJasmin(messySource);
    t.equal(
      stripComments(formatted),
      stripComments(canonical),
      'code sans comments should match canonical output',
    );
    t.end();
  });
});
