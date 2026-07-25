'use strict';

const test = require('tape');
const { createInProcessLspHarness } = require('../src/lsp/inProcessHarness');
const { JasminLspServer } = require('../src/lsp/JasminLspServer');

test('LSP server formats Jasmin documents while preserving comments', async (t) => {
  const harness = createInProcessLspHarness({
    createServer: (connection) => new JasminLspServer(connection),
  });

  await harness.initialize({});
  const uri = 'file:///Foo.j';
  const messy = `
.version 55 0
; header comment
.class public super Foo
.super java/lang/Object
.method public static test : ()V
    .code stack 1 locals 1
L0:     return    ; tail comment
    .end code
.end method
.end class
`.trim();

  harness.notify('textDocument/didOpen', {
    textDocument: { uri, text: messy },
  });

  const edits = await harness.request('textDocument/formatting', {
    textDocument: { uri },
    options: { tabSize: 4, insertSpaces: true },
  });

  t.ok(Array.isArray(edits), 'formatting request should return an array');
  t.equal(edits.length, 1, 'formatting should produce a single full-document edit');
  const newText = edits[0]?.newText;
  t.ok(newText.includes('; header comment'), 'standalone comment should remain after formatting');
  t.ok(/return\s+; tail comment/.test(newText), 'inline comment should remain attached');

  await harness.shutdown();
  t.end();
});
