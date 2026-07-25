'use strict';

const test = require('tape');
const { createInProcessLspHarness } = require('../src/lsp/inProcessHarness');
const { JasminLspServer } = require('../src/lsp/JasminLspServer');

function openText(harness, uri, text) {
  harness.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'jasmin', version: 1, text },
  });
}

test('go to definition resolves plain signature references', async (t) => {
  t.plan(4);
  const harness = createInProcessLspHarness({
    createServer: (connection) => new JasminLspServer(connection),
  });
  await harness.initialize({});

  const fooUri = 'file:///Foo.j';
  const fooText = `
.class public Foo
.super java/lang/Object

.method public static callee : (ILjava/lang/String;)V
    .code stack 1 locals 2
L0:    return
    .end code
.end method
.end class
`.trim();
  openText(harness, fooUri, fooText);

const helperUri = 'file:///Helper.j';
  const helperText = `
.class public Helper
.super java/lang/Object

; reference Foo.callee(ILjava/lang/String;)V from a comment
.method public static caller : ()V
    .code stack 1 locals 0
L0:    return
    .end code
.end method
.end class
`.trim();
  openText(harness, helperUri, helperText);

  const helperLines = helperText.split('\n');
  const referenceLine = helperLines.findIndex((line) => line.includes('Foo.callee'));
  const character = helperLines[referenceLine].indexOf('Foo.callee') + 5;

  const fooLines = fooText.split('\n');
  const fooMethodLine = fooLines.findIndex((line) => line.startsWith('.method'));
  const fooMethodChar = fooLines[fooMethodLine].indexOf('callee');

  const definition = await harness.request('textDocument/definition', {
    textDocument: { uri: helperUri },
    position: { line: referenceLine, character },
  });

  t.ok(Array.isArray(definition) && definition.length === 1, 'definition result returned');
  const location = definition[0];
  t.equal(location.uri, fooUri, 'definition points to Foo.j');
  t.equal(location.range.start.line, fooMethodLine, 'range starts on method line');
  t.equal(location.range.start.character, fooMethodChar, 'range points to method name column');

  await harness.shutdown();
});
