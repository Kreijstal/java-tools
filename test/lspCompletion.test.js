'use strict';

const test = require('tape');
const { createInProcessLspHarness } = require('../src/lsp/inProcessHarness');
const { JasminLspServer } = require('../src/lsp/JasminLspServer');

function openDocument(harness, uri, text) {
  harness.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'jasmin', version: 1, text },
  });
}

test('opcode completion offers suggestions after labels', async (t) => {
  t.plan(2);
  const harness = createInProcessLspHarness({
    createServer: (connection) => new JasminLspServer(connection),
  });
  await harness.initialize({});

  const uri = 'file:///Workspace/Foo.j';
  const text = `
.class public Foo
.super java/lang/Object

.method public static main : ()V
    .code stack 1 locals 0
L0:    ico
    return
    .end code
.end method
.end class
`.trim();
  openDocument(harness, uri, text);

  const lines = text.split('\n');
  const targetLine = lines.findIndex((line) => line.includes('ico'));
  const character = lines[targetLine].indexOf('ico') + 3;

  const items = await harness.request('textDocument/completion', {
    textDocument: { uri },
    position: { line: targetLine, character },
  });

  t.ok(Array.isArray(items) && items.length > 0, 'completion returns opcode candidates');
  t.ok(items.some((item) => item.label === 'iconst_0'), 'iconst_0 suggested for "ico" prefix');

  await harness.shutdown();
});

test('opcode completion ignores tokens inside comments', async (t) => {
  t.plan(1);
  const harness = createInProcessLspHarness({
    createServer: (connection) => new JasminLspServer(connection),
  });
  await harness.initialize({});

  const uri = 'file:///Workspace/Bar.j';
  const text = `
.class public Bar
.super java/lang/Object

.method public static test : ()V
    .code stack 1 locals 0
    ; il
    return
    .end code
.end method
.end class
`.trim();
  openDocument(harness, uri, text);

  const lines = text.split('\n');
  const commentLine = lines.findIndex((line) => line.includes('; il'));
  const character = lines[commentLine].indexOf('il') + 2;

  const items = await harness.request('textDocument/completion', {
    textDocument: { uri },
    position: { line: commentLine, character },
  });

  t.equal(items.length, 0, 'no completion suggestions inside comments');

  await harness.shutdown();
});

test('method completion suggests methods for invoke operands', async (t) => {
  t.plan(1);
  const harness = createInProcessLspHarness({
    createServer: (connection) => new JasminLspServer(connection),
  });
  await harness.initialize({});

  const fooUri = 'file:///Foo.j';
  const fooText = `
.class public Foo
.super java/lang/Object

.method public static target : ()V
    .code stack 1 locals 0
L0:    return
    .end code
.end method
.end class
`.trim();
  openDocument(harness, fooUri, fooText);

  const helperUri = 'file:///Helper.j';
  const helperText = `
.class public Helper
.super java/lang/Object

.method public static caller : ()V
    .code stack 2 locals 0
L0:    invokevirtual Method Foo t
L1:    return
    .end code
.end method
.end class
`.trim();
  openDocument(harness, helperUri, helperText);

  const lines = helperText.split('\n');
  const targetLine = lines.findIndex((line) => line.includes(' invokevirtual'));
  const methodStart = lines[targetLine].indexOf(' Foo ') + ' Foo '.length;
  const character = methodStart + 1;

  const items = await harness.request('textDocument/completion', {
    textDocument: { uri: helperUri },
    position: { line: targetLine, character },
  });

  t.ok(items.some((item) => item.label === 'target'), 'method name suggested for invoke operand');

  await harness.shutdown();
});

test('method completion works for Class.method signatures', async (t) => {
  t.plan(1);
  const harness = createInProcessLspHarness({
    createServer: (connection) => new JasminLspServer(connection),
  });
  await harness.initialize({});

  const fooUri = 'file:///Foo.j';
  const fooText = `
.class public Foo
.super java/lang/Object

.method public static target : ()V
    .code stack 1 locals 0
L0:    return
    .end code
.end method
.end class
`.trim();
  openDocument(harness, fooUri, fooText);

  const helperUri = 'file:///Helper.j';
  const helperText = `
.class public Helper
.super java/lang/Object

.method public static caller : ()V
    .code stack 2 locals 0
L0:    ; reference Foo.t
L1:    return
    .end code
.end method
.end class
`.trim();
  openDocument(harness, helperUri, helperText);

  const lines = helperText.split('\n');
  const targetLine = lines.findIndex((line) => line.includes('Foo.t'));
  const sig = 'Foo.t';
  const character = lines[targetLine].indexOf(sig) + sig.length;

  const items = await harness.request('textDocument/completion', {
    textDocument: { uri: helperUri },
    position: { line: targetLine, character },
  });

  t.ok(items.some((item) => item.label === 'target'), 'Class.method style completion returns workspace methods');

  await harness.shutdown();
});

test('field completion suggests names for getstatic operands', async (t) => {
  t.plan(1);
  const harness = createInProcessLspHarness({
    createServer: (connection) => new JasminLspServer(connection),
  });
  await harness.initialize({});

  const fooUri = 'file:///Foo.j';
  const fooText = `
.class public Foo
.super java/lang/Object

.field public static counter I

.method public static init : ()V
    .code stack 1 locals 0
L0:    return
    .end code
.end method
.end class
`.trim();
  openDocument(harness, fooUri, fooText);

  const helperUri = 'file:///Helper.j';
  const helperText = `
.class public Helper
.super java/lang/Object

.method public static caller : ()V
    .code stack 1 locals 0
L0:    getstatic Field Foo c
L1:    return
    .end code
.end method
.end class
`.trim();
  openDocument(harness, helperUri, helperText);

  const lines = helperText.split('\n');
  const targetLine = lines.findIndex((line) => line.includes('getstatic'));
  const character = lines[targetLine].lastIndexOf('c') + 1;

  const items = await harness.request('textDocument/completion', {
    textDocument: { uri: helperUri },
    position: { line: targetLine, character },
  });

  t.ok(items.some((item) => item.label === 'counter'), 'field name suggested for getstatic operand');

  await harness.shutdown();
});

test('constant completion offers suggestions for ldc strings', async (t) => {
  t.plan(1);
  const harness = createInProcessLspHarness({
    createServer: (connection) => new JasminLspServer(connection),
  });
  await harness.initialize({});

  const uri = 'file:///ConstUser.j';
  const text = `
.class public ConstUser
.super java/lang/Object

.method public static first : ()V
    .code stack 1 locals 0
L0:    ldc "HelloWorld"
L1:    return
    .end code
.end method

.method public static second : ()V
    .code stack 1 locals 0
L0:    ldc "He
L1:    return
    .end code
.end method
.end class
`.trim();
  openDocument(harness, uri, text);

  const lines = text.split('\n');
  const targetLine = lines.findIndex(
    (line) => line.includes('ldc "He') && !line.includes('HelloWorld'),
  );
  const character = lines[targetLine].length;

  const items = await harness.request('textDocument/completion', {
    textDocument: { uri },
    position: { line: targetLine, character },
  });

  t.ok(items.some((item) => item.label === 'HelloWorld'), 'ldc suggestions include known constants');

  await harness.shutdown();
});
