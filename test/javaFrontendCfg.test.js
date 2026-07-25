'use strict';

const test = require('tape');
const frontend = require('../src/java-frontend');

function sampleCfg() {
  const builder = frontend.createCfgBuilder('cfg:method:Example.f', {
    kind: 'MethodCfg',
    ownerNodeId: 'n-method',
    ownerKind: 'MethodDeclaration',
    ownerName: 'f',
  });
  const entry = builder.block('EntryBlock', { id: 'entry' });
  const body = builder.block('BasicBlock', {
    id: 'body',
    astNodeIds: ['n-return'],
    statements: [frontend.createAstStatementRef('n-return', { role: 'return' })],
  });
  const exit = builder.block('ExitBlock', { id: 'exit', terminator: frontend.exitTerminator() });
  builder.edge(entry, body, 'normal', { id: 'e-entry-body' });
  builder.edge(body, exit, 'return', { id: 'e-body-exit', sourceNodeId: 'n-return' });
  builder.setTerminator(entry, frontend.gotoTerminator('body'));
  builder.setTerminator(body, frontend.returnTerminator(null, { target: 'exit' }));
  return frontend.createCfgDocument([builder.toGraph()], { sourceLevel: 8 });
}

test('CFG document can be created, validated, serialized, and deserialized', (t) => {
  const cfg = sampleCfg();
  t.equal(cfg.schema, frontend.CFG_SCHEMA_ID);
  t.equal(cfg.version, frontend.CFG_SCHEMA_VERSION);
  t.equal(cfg.graphs.length, 1);
  t.equal(cfg.graphs[0].entryBlockId, 'entry');
  t.equal(cfg.graphs[0].exitBlockId, 'exit');
  t.doesNotThrow(() => frontend.validateCfgDocument(cfg));

  const serialized = frontend.serializeCfg(cfg);
  const restored = frontend.deserializeCfg(serialized);
  t.deepEqual(restored, frontend.toCfgJson(cfg));
  t.end();
});

test('CFG validation rejects dangling edge and terminator block references', (t) => {
  const graphWithDanglingEdge = frontend.createCfgGraph('cfg:bad-edge', {
    kind: 'MethodCfg',
    blocks: [frontend.createCfgBlock('entry', { kind: 'EntryBlock' })],
    edges: [frontend.createCfgEdge('e0', 'entry', 'missing')],
    entryBlockId: 'entry',
  });
  t.throws(
    () => frontend.validateCfgDocument(frontend.createCfgDocument([graphWithDanglingEdge])),
    /unknown block: missing/,
  );

  const graphWithDanglingTerminator = frontend.createCfgGraph('cfg:bad-terminator', {
    kind: 'MethodCfg',
    blocks: [frontend.createCfgBlock('entry', {
      kind: 'EntryBlock',
      terminator: frontend.gotoTerminator('missing'),
    })],
    entryBlockId: 'entry',
  });
  t.throws(
    () => frontend.validateCfgDocument(frontend.createCfgDocument([graphWithDanglingTerminator])),
    /unknown block: missing/,
  );
  t.end();
});

test('CFG supports conditional and switch terminators', (t) => {
  const graph = frontend.createCfgGraph('cfg:branches', {
    kind: 'MethodCfg',
    entryBlockId: 'cond',
    exitBlockId: 'exit',
    blocks: [
      frontend.createCfgBlock('cond', {
        kind: 'ConditionBlock',
        terminator: frontend.conditionalBranchTerminator('n-cond', 'then', 'else'),
      }),
      frontend.createCfgBlock('then', {
        kind: 'BasicBlock',
        terminator: frontend.gotoTerminator('exit'),
      }),
      frontend.createCfgBlock('else', {
        kind: 'SwitchDispatchBlock',
        terminator: frontend.switchBranchTerminator('n-switch', [
          { caseValue: 1, label: 'case 1', target: 'then' },
          { caseValue: 2, label: 'case 2', target: 'exit' },
        ], 'exit'),
      }),
      frontend.createCfgBlock('exit', { kind: 'ExitBlock', terminator: frontend.exitTerminator() }),
    ],
    edges: [
      frontend.createCfgEdge('e0', 'cond', 'then', { kind: 'true', conditionNodeId: 'n-cond' }),
      frontend.createCfgEdge('e1', 'cond', 'else', { kind: 'false', conditionNodeId: 'n-cond' }),
      frontend.createCfgEdge('e2', 'else', 'then', { kind: 'case', caseValue: 1 }),
      frontend.createCfgEdge('e3', 'else', 'exit', { kind: 'default' }),
    ],
  });
  const cfg = frontend.createCfgDocument([graph]);
  t.doesNotThrow(() => frontend.validateCfgDocument(cfg));
  t.equal(cfg.graphs[0].blocks[0].terminator.trueTarget, 'then');
  t.equal(cfg.graphs[0].blocks[2].terminator.cases.length, 2);
  t.end();
});

test('CFG document can be attached to AST metadata and survive AST serialization', (t) => {
  const astDocument = frontend.createAstDocument(
    frontend.compilationUnit({
      typeDeclarations: [
        frontend.classDeclaration('Example', {
          body: [
            frontend.methodDeclaration('f', frontend.primitiveType('int'), {
              body: frontend.blockStatement([frontend.returnStatement(frontend.literalExpression(1, 'integer', '1'))]),
            }),
          ],
        }),
      ],
    }),
    { sourceLevel: 8 },
  );
  const cfg = sampleCfg();
  frontend.attachCfgDocument(astDocument, cfg);
  const attached = frontend.getAttachedCfgDocument(astDocument);
  t.deepEqual(attached, frontend.toCfgJson(cfg));

  const restoredAst = frontend.deserializeAst(frontend.serializeAst(astDocument));
  const restoredCfg = frontend.getAttachedCfgDocument(restoredAst);
  t.deepEqual(restoredCfg, frontend.toCfgJson(cfg));
  t.end();
});

test('CFG node-location annotations are serializable', (t) => {
  const node = frontend.returnStatement(frontend.literalExpression(0, 'integer', '0'));
  frontend.annotateNodeWithCfgLocation(node, {
    graphId: 'cfg:method:Example.f',
    blockId: 'body',
    statementIndex: 0,
    role: 'terminator',
  });
  t.ok(frontend.hasNodeCfgLocation(node));
  t.deepEqual(frontend.getNodeCfgLocation(node), {
    graphId: 'cfg:method:Example.f',
    blockId: 'body',
    edgeId: null,
    statementIndex: 0,
    role: 'terminator',
  });
  t.doesNotThrow(() => frontend.validateAstNode(node));
  frontend.removeNodeCfgLocation(node);
  t.notOk(frontend.hasNodeCfgLocation(node));
  t.end();
});

test('CFG builder creates validated cloned graph output', (t) => {
  const builder = frontend.createCfgBuilder('cfg:linear', { kind: 'SyntheticCfg' });
  const entry = builder.block('EntryBlock');
  const exit = builder.block('ExitBlock', { terminator: frontend.exitTerminator() });
  builder.setTerminator(entry, frontend.gotoTerminator(exit.id));
  builder.edge(entry, exit);
  const graph = builder.toGraph();
  graph.blocks.push(frontend.createCfgBlock('external-mutation'));
  const original = builder.toGraph();
  t.equal(original.blocks.length, 2, 'builder graph was not mutated by cloned output');
  t.doesNotThrow(() => frontend.validateCfgGraph(original));
  t.end();
});

test('CFG rejects non-JSON metadata', (t) => {
  const cfg = frontend.createCfgDocument([], { meta: { bad() {} } });
  t.throws(() => frontend.validateCfgDocument(cfg), /non-JSON value/);
  t.throws(() => frontend.serializeCfg(cfg), /non-JSON value/);
  t.end();
});

test('CFG initialization pass attaches an empty sidecar', (t) => {
  const astDocument = frontend.createAstDocument(frontend.compilationUnit(), { sourceLevel: 11 });
  const result = frontend.runAstPasses(astDocument, [
    frontend.createInitializeCfgDocumentPass(),
  ]);
  const cfg = frontend.getAttachedCfgDocument(result);
  t.ok(cfg, 'CFG sidecar is attached');
  t.equal(cfg.sourceLevel, 11);
  t.equal(cfg.graphs.length, 0);
  t.doesNotThrow(() => frontend.validateCfgDocument(cfg));
  t.end();
});
