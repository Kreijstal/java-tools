'use strict';

// Regression test: members of an aggregate held on the operand stack must be
// frozen when a store clobbers a local they read.
//
// A scalar operand is consumed soon after it is pushed, so spilling it before a
// store is enough. An array literal is different: it stays on the operand stack
// until it is rendered, so its already-collected elements can outlive any number
// of stores to the locals they read. An element left as a lazily-rendered local
// read therefore yields the value at render time rather than the value at its
// own position in the sequence.
//
// The dup-filled vertex array below is the shape that exposed it:
//
//     dup / iconst_0 / iload_0 / iastore                 <- element 0 == pre-store param0
//     dup / iconst_1 / iload_0 / iload_1 / iadd / dup
//           istore_0 / iastore                           <- element 1, and param0 is clobbered
//     dup / iconst_2 / iload_0 / iastore                 <- element 2 == post-store param0
//
// Elements 0 and 2 read the same local and must render differently. Before the
// fix both came out as a bare `param0`, so element 0 silently reported the
// post-store value.
//
// Found in voidhunters. `wlb` builds the game's config geometry as running
// accumulations feeding dup-filled vertex arrays; the stale elements corrupted
// the polygon handed to `wfb`, which left `hab.field_g[3].field_o` one entry
// short (15 instead of 16). `ml`'s constructor sizes `field_d` from that length,
// so a later `field_d[15]` threw ArrayIndexOutOfBoundsException on the loading
// thread. The game's top-level handler swallowed it, the thread died, and the
// applet hung at a blank loading screen until the harness timed out at 600s --
// no stack trace, no crash, just a game that never reached its menu.
//
// The spill is deliberately narrow: element 2 is a genuinely-final read and must
// stay a bare `param0`, proving only stale members are frozen.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile } = require('../src/decompiler/cfr');

// Version 50 matches the gamepack and needs no hand-written StackMapTable.
const ARRAY_LITERAL_JASMIN = `.version 50 0
.class public super Vertices
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
        aload_0
        invokespecial Method java/lang/Object <init> ()V
        return
    .end code
.end method

.method public static build : (II)[I
    .code stack 6 locals 2
        iconst_3
        newarray int
        dup
        iconst_0
        iload_0
        iastore
        dup
        iconst_1
        iload_0
        iload_1
        iadd
        dup
        istore_0
        iastore
        dup
        iconst_2
        iload_0
        iastore
        areturn
    .end code
.end method
.end class
`;

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function arrayLiteralElements(source) {
  const match = source.match(/new int\[\]\{([^}]*)\}/);
  return match ? match[1].split(',').map((piece) => piece.trim()) : null;
}

test('CFR-JS freezes array-literal elements a later store would invalidate', (t) => {
  withTempDir('cfr-array-literal-staleness-', (tempDir) => {
    const classPath = path.join(tempDir, 'Vertices.class');
    assembleJasminSource(ARRAY_LITERAL_JASMIN, classPath);
    const source = decompileClassFile(classPath);

    const elements = arrayLiteralElements(source);
    t.ok(elements, 'the vertex array is emitted as an array literal');
    t.equal(elements.length, 3, 'all three elements are present');

    // The defect: element 0 renders as a bare `param0` and so reports the value
    // written by the store that follows it.
    t.notEqual(elements[0], 'param0',
      'element 0 keeps the value param0 held before the store, not a bare re-read');
    t.notEqual(elements[0], elements[2],
      'the pre-store and post-store reads of param0 render differently');

    // The store's own dup'd value is reused rather than re-evaluated, so the sum
    // is computed exactly once.
    t.equal((source.match(/param0 \+ param1/g) || []).length, 1,
      'the dup\'d sum is evaluated once');

    // The spill stays narrow: a read that nothing invalidates is left alone.
    t.equal(elements[2], 'param0',
      'element 2 is a genuinely-final read and is not spilled');

    t.end();
  });
});
