'use strict';

const test = require('tape');
const frontend = require('../src/java-frontend');
const { CFG, BasicBlock } = require('../src/cfg/cfg');

function sampleAst(returnNodeRef = {}) {
  const returnNode = frontend.returnStatement(frontend.literalExpression(1, 'integer', '1'));
  returnNodeRef.node = returnNode;
  return frontend.createAstDocument(
    frontend.compilationUnit({
      typeDeclarations: [
        frontend.classDeclaration('Example', {
          body: [
            frontend.methodDeclaration('add', frontend.primitiveType('int'), {
              parameters: [
                frontend.formalParameter('a', frontend.primitiveType('int')),
                frontend.formalParameter('b', frontend.primitiveType('int')),
              ],
              body: frontend.blockStatement([returnNode]),
            }),
          ],
        }),
      ],
    }),
    { sourceLevel: 8 },
  );
}

function sampleBytecodeCfgGraph() {
  return {
    id: 'bytecode-cfg:Example.add:(II)I',
    kind: 'BytecodeMethodCfg',
    methodKey: {
      owner: null,
      name: 'add',
      descriptor: null,
    },
    entryBlockId: 'bb0',
    exitBlockId: 'bb0',
    blocks: [
      {
        id: 'bb0',
        kind: 'BasicBlock',
        instructionOffsets: [0, 1, 2, 3],
        firstOffset: 0,
        lastOffset: 3,
        instructionCount: 4,
      },
    ],
    edges: [],
  };
}

test('CFG join document is serializable, deserializable, and validates graph references', (t) => {
  const javaCfg = frontend.createCfgDocument([
    frontend.createCfgGraph('java-cfg:n1', {
      kind: 'MethodCfg',
      entryBlockId: 'entry',
      exitBlockId: 'exit',
      blocks: [
        frontend.createCfgBlock('entry', { kind: 'EntryBlock', terminator: frontend.gotoTerminator('exit') }),
        frontend.createCfgBlock('exit', { kind: 'ExitBlock', terminator: frontend.exitTerminator() }),
      ],
      edges: [frontend.createCfgEdge('e0', 'entry', 'exit')],
    }),
  ]);
  const bytecodeCfg = frontend.createBytecodeCfgDocument([sampleBytecodeCfgGraph()]);
  const join = frontend.createCfgJoinDocument([
    frontend.createMethodCfgJoin('join:Example.add', {
      method: { name: 'add' },
      javaGraphId: 'java-cfg:n1',
      bytecodeGraphId: 'bytecode-cfg:Example.add:(II)I',
      correspondences: [
        frontend.createCfgCorrespondence('corr:0', {
          kind: 'GraphToGraph',
          java: { graphId: 'java-cfg:n1' },
          bytecode: { graphId: 'bytecode-cfg:Example.add:(II)I' },
          relation: 'implements',
          confidence: 'high',
          evidence: [{ kind: 'test' }],
        }),
      ],
    }),
  ]);

  t.doesNotThrow(() => frontend.validateCfgJoinDocument(join));
  t.doesNotThrow(() => frontend.validateCfgJoinAgainstDocuments(join, javaCfg, bytecodeCfg));
  const serialized = frontend.serializeCfgJoin(join);
  const restored = frontend.deserializeCfgJoin(serialized);
  t.deepEqual(restored, frontend.toCfgJoinJson(join));
  t.end();
});

test('CFG join validation rejects dangling graph references', (t) => {
  const join = frontend.createCfgJoinDocument([
    frontend.createMethodCfgJoin('join:bad', {
      javaGraphId: 'missing-java-graph',
      correspondences: [],
    }),
  ]);
  t.throws(
    () => frontend.validateCfgJoinAgainstDocuments(join, frontend.createCfgDocument([]), frontend.createBytecodeCfgDocument([])),
    /unknown Java CFG graph/,
  );
  t.end();
});

test('join stub pipeline creates Java CFG, bytecode CFG, anchors, join sidecar, and validation diagnostics', (t) => {
  const returnNodeRef = {};
  const astDocument = sampleAst(returnNodeRef);
  const returnNode = astDocument.root.typeDeclarations[0].body[0].body.statements[0];
  frontend.annotateNode(returnNode, frontend.BYTECODE_ORIGIN_ANNOTATION_KEY, {
    methodKey: { name: 'add' },
    instructionOffsets: [0, 1, 2, 3],
    role: 'return',
  });

  const result = frontend.runAstPasses(astDocument, frontend.createCfgJoinStubPasses({
    normalizeBytecodeCfg: {
      bytecodeCfg: frontend.createBytecodeCfgDocument([sampleBytecodeCfgGraph()]),
    },
  }), { recordHistory: true });

  const javaCfg = frontend.getAttachedCfgDocument(result);
  const bytecodeCfg = frontend.getAttachedBytecodeCfgDocument(result);
  const anchors = frontend.getAttachedCfgJoinAnchors(result);
  const join = frontend.getAttachedCfgJoinDocument(result);

  t.equal(javaCfg.graphs.length, 1, 'one skeletal Java CFG graph was created');
  t.equal(javaCfg.graphs[0].blocks[1].kind, 'UnsupportedBlock', 'method body is explicitly stubbed');
  t.equal(bytecodeCfg.graphs.length, 1, 'bytecode CFG sidecar is attached');
  t.equal(anchors.anchors.length, 1, 'bytecode-origin annotation was collected');
  t.equal(join.joins.length, 1, 'one method join was created');
  t.equal(join.joins[0].bytecodeGraphId, 'bytecode-cfg:Example.add:(II)I');
  t.ok(join.joins[0].correspondences.some((entry) => entry.kind === 'GraphToGraph'), 'graph correspondence exists');
  t.ok(join.joins[0].correspondences.some((entry) => entry.kind === 'NodeToInstructions'), 'anchor correspondence exists');
  t.doesNotThrow(() => frontend.validateCfgJoinAgainstDocuments(join, javaCfg, bytecodeCfg));
  t.ok(result.meta.passManager.runs.some((run) => run.name === 'frontend.validateCfgJoin'), 'validation pass ran');
  t.end();
});

test('bytecode CFG normalizer accepts legacy CFG instances', (t) => {
  const cfg = new CFG('block_0');
  const block0 = new BasicBlock('block_0');
  block0.addInstruction({ pc: 0, instruction: { op: 'iload_1' } });
  block0.addInstruction({ pc: 1, instruction: { op: 'ireturn' } });
  cfg.addBlock(block0);
  cfg.context = { className: 'Example', methodName: 'add', descriptor: '(II)I' };

  const normalized = frontend.normalizeBytecodeCfgDocument(cfg);
  t.equal(normalized.schema, frontend.BYTECODE_CFG_SCHEMA_ID);
  t.equal(normalized.graphs.length, 1);
  t.equal(normalized.graphs[0].entryBlockId, 'block_0');
  t.deepEqual(normalized.graphs[0].blocks[0].instructionOffsets, [0, 1]);
  t.deepEqual(normalized.graphs[0].methodKey, {
    owner: 'Example',
    name: 'add',
    descriptor: '(II)I',
    sourceName: null,
  });
  t.end();
});

test('join pipeline can run with missing bytecode CFG and records an unmatched graph diagnostic', (t) => {
  const astDocument = sampleAst();
  const result = frontend.runAstPasses(astDocument, frontend.createCfgJoinStubPasses({
    normalizeBytecodeCfg: {},
  }));
  const join = frontend.getAttachedCfgJoinDocument(result);
  t.equal(join.joins.length, 1);
  t.equal(join.joins[0].bytecodeGraphId, null);
  t.ok(join.diagnostics.some((diagnostic) => diagnostic.code === 'BYTECODE_CFG_GRAPH_MISSING'));
  t.doesNotThrow(() => frontend.validateCfgJoinDocument(join));
  t.end();
});
