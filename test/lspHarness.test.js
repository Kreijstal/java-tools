const test = require('tape');
const { createInProcessLspHarness } = require('../src/lsp/inProcessHarness');
const { convertAstToCfg } = require('../src/ast-to-cfg');
const { eliminateDeadCodeCfg } = require('../src/deadCodeEliminator-cfg');
const { reconstructAstFromCfg } = require('../src/cfg-to-ast');
const MISPLACED_CATCH_SOURCE = `
.version 55 0
.class public super Misplaced
.super java/lang/Object

.method public static funnel : (I)I
    .code stack 2 locals 1
        .catch java/lang/Exception from L0 to L2 using L3
L0:     iconst_0
L1:     goto L3
L2:     athrow
L3:     iconst_1
L4:     ireturn
    .end code
.end method
.end class
`.trim();

function createSyntheticMisplacedAst() {
  return {
    classes: [
      {
        className: 'Misplaced',
        items: [
          {
            type: 'method',
            method: {
              name: 'funnel',
              descriptor: '(I)I',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '2',
                    localsSize: '1',
                    codeItems: [
                      { pc: 0, labelDef: 'L0:', instruction: 'iconst_0' },
                      { pc: 1, labelDef: 'L1:', instruction: { op: 'goto', arg: 'L3' } },
                      { pc: 2, labelDef: 'L2:', instruction: 'athrow' },
                      { pc: 3, labelDef: 'L3:', instruction: 'iconst_1' },
                      { pc: 4, labelDef: 'L4:', instruction: 'ireturn' },
                    ],
                    exceptionTable: [
                      {
                        start_pc: 0,
                        end_pc: 3,
                        handler_pc: 3,
                        catch_type: 'java/lang/Exception',
                      },
                    ],
                    attributes: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

class FakeLspServer {
  constructor(connection) {
    this.connection = connection;
    this.openDocuments = new Map();
  }

  async initialize(params) {
    this.clientCapabilities = params.capabilities || {};
    return {
      capabilities: {
        textDocumentSync: 1,
        completionProvider: {},
      },
    };
  }

  async handleRequest(method, params) {
    if (method === 'textDocument/completion') {
      const items = [
        { label: 'iconst_0', kind: 14 },
        { label: 'goto', kind: 14 },
      ];
      return { items };
    }
    if (method === 'workspace/symbol') {
      return [{ name: 'MisplacedCatch.funnel', kind: 12 }];
    }
    throw new Error(`Unhandled request method ${method}`);
  }

  handleNotification(method, params) {
    if (method === 'textDocument/didOpen') {
      const { textDocument } = params;
      this.openDocuments.set(textDocument.uri, textDocument.text);
      this.connection.publishDiagnostics(textDocument.uri, []);
      return;
    }
    if (method === 'textDocument/didChange') {
      const { textDocument, contentChanges } = params;
      const change = contentChanges[0]?.text ?? '';
      this.openDocuments.set(textDocument.uri, change);
      if (change.includes('athrow')) {
        this.connection.publishDiagnostics(textDocument.uri, [
          {
            range: {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 10 },
            },
            message: 'Unhandled throw instruction',
            severity: 2,
          },
        ]);
      }
    }
  }
}

test('createInProcessLspHarness wires requests and notifications', async (t) => {
  t.plan(7);

  const harness = createInProcessLspHarness({
    createServer: (connection) => new FakeLspServer(connection),
  });

  const initResult = await harness.initialize({ capabilities: {} });
  t.ok(initResult.capabilities, 'initialize should return capabilities');

  let diagEvents = 0;
  const unsubscribe = harness.on('textDocument/publishDiagnostics', ({ params }) => {
    t.equal(params.uri, 'file:///MisplacedCatch.j', 'diagnostics should target correct URI');
    if (diagEvents === 0) {
      t.equal(params.diagnostics.length, 0, 'initial open should emit empty diagnostics');
    } else {
      t.equal(params.diagnostics.length, 1, 'diagnostics payload captured');
    }
    diagEvents += 1;
  });

  harness.notify('textDocument/didOpen', {
    textDocument: { uri: 'file:///MisplacedCatch.j', text: '.class public MisplacedCatch' },
  });

  harness.notify('textDocument/didChange', {
    textDocument: { uri: 'file:///MisplacedCatch.j' },
    contentChanges: [{ text: 'athrow' }],
  });

  const completion = await harness.request('textDocument/completion', {
    textDocument: { uri: 'file:///MisplacedCatch.j' },
    position: { line: 0, character: 0 },
  });

  t.equal(completion.items.length, 2, 'completions are returned');
  t.ok(harness.getNotifications().length >= 2, 'notifications are recorded');

  unsubscribe();
  await harness.shutdown();
});

test('in-process harness captures dead-code diagnostics and fixes', async (t) => {
  t.plan(4);

  class DeadCodeServer {
    constructor(connection) {
      this.connection = connection;
      this.documents = new Map();
    }

    async initialize() {
      return { capabilities: { textDocumentSync: 1 } };
    }

    handleNotification(method, params) {
      if (method === 'textDocument/didOpen') {
        this.documents.set(params.textDocument.uri, params.textDocument.text);
        this._analyze(params.textDocument.uri);
      } else if (method === 'textDocument/didChange') {
        const text = params.contentChanges[0]?.text ?? '';
        this.documents.set(params.textDocument.uri, text);
        this._analyze(params.textDocument.uri);
      }
    }

    _analyze(uri) {
      const text = this.documents.get(uri) || '';
      const diagnostics = [];
      if (text.includes('goto') && text.includes('athrow')) {
        diagnostics.push({
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          message: 'Dead handler block detected',
          severity: 2,
          code: 'dead-code',
          data: this._buildFix(),
        });
      }
      this.connection.publishDiagnostics(uri, diagnostics);
    }

    _buildFix() {
      const classAst = createSyntheticMisplacedAst();
      const classItem = classAst.classes[0];
      const methodEntry = classItem.items.find((it) => it.type === 'method');
      if (!methodEntry) {
        return null;
      }
      const method = methodEntry.method;
      const cfg = convertAstToCfg(method);
      const { changed, optimizedCfg } = eliminateDeadCodeCfg(cfg);
      if (!changed) {
        return null;
      }
      const optimizedMethod = reconstructAstFromCfg(optimizedCfg, method);
      methodEntry.method = optimizedMethod;
      return classAst;
    }
  }

  const harness = createInProcessLspHarness({
    createServer: (connection) => new DeadCodeServer(connection),
  });

  await harness.initialize();

  const fixes = [];
  const unsubscribe = harness.on('textDocument/publishDiagnostics', ({ params }) => {
    if (params.diagnostics.length) {
      fixes.push(params.diagnostics[0].data);
    }
  });

  harness.notify('textDocument/didOpen', {
    textDocument: { uri: 'file:///Misplaced.j', text: MISPLACED_CATCH_SOURCE },
  });

  t.equal(fixes.length, 1, 'diagnostic should include fix data');
  const optimized = fixes[0];
  t.ok(optimized, 'optimized method should be present in diagnostic data');
  if (optimized) {
    const optimizedMethod = optimized.classes[0].items.find((item) => item.type === 'method').method;
    const instructions = optimizedMethod.attributes.find((a) => a.type === 'code').code.codeItems;
    t.equal(
      instructions.filter((ci) => ci.instruction === 'athrow').length,
      0,
      'optimized method removes athrow',
    );
  }

  unsubscribe();
  await harness.shutdown();
  t.pass('shutdown completes');
});
