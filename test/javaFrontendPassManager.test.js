'use strict';

const test = require('tape');
const frontend = require('../src/java-frontend');

function makeLiteralReturnDocument(value = 1) {
  const intType = frontend.primitiveType('int');
  return frontend.createAstDocument(
    frontend.compilationUnit({
      typeDeclarations: [
        frontend.classDeclaration('A', {
          body: [
            frontend.methodDeclaration('answer', intType, {
              body: frontend.blockStatement([
                frontend.returnStatement(frontend.literalExpression(value, 'number', String(value))),
              ]),
            }),
          ],
        }),
      ],
    }),
    { sourceLevel: 8 },
  );
}

test('Java frontend node annotations are serializable metadata', (t) => {
  const document = makeLiteralReturnDocument(1);
  const expression = document.root.typeDeclarations[0].body[0].body.statements[0].expression;

  frontend.annotateNode(expression, 'analysis.constantValue', { value: 1, confidence: 'exact' });
  t.ok(frontend.hasNodeAnnotation(expression, 'analysis.constantValue'), 'annotation is attached to the node');
  t.deepEqual(
    frontend.getNodeAnnotation(expression, 'analysis.constantValue'),
    { value: 1, confidence: 'exact' },
    'annotation can be read back',
  );

  const restored = frontend.deserializeAst(frontend.serializeAst(document));
  const restoredExpression = restored.root.typeDeclarations[0].body[0].body.statements[0].expression;
  t.deepEqual(
    frontend.getNodeAnnotation(restoredExpression, 'analysis.constantValue'),
    { value: 1, confidence: 'exact' },
    'annotation survives AST serialization/deserialization',
  );
  t.end();
});

test('Java frontend node annotations reject non-JSON values', (t) => {
  const node = frontend.identifier('x');
  t.throws(
    () => frontend.annotateNode(node, 'bad.function', () => 1),
    /non-JSON value/,
    'function annotations are rejected',
  );

  const cyclic = {};
  cyclic.self = cyclic;
  t.throws(
    () => frontend.annotateNode(node, 'bad.cycle', cyclic),
    /cycle/,
    'cyclic annotations are rejected',
  );
  t.end();
});

test('Java frontend traversal visits syntax nodes and exposes path context', (t) => {
  const document = frontend.parseJava('class A { int answer() { return 1; } }');
  const seen = [];

  frontend.visitAst(document, {
    enter(node, context) {
      if (node.kind === 'MethodDeclaration' || node.kind === 'ReturnStatement') {
        seen.push({ kind: node.kind, path: context.path.join('.') });
      }
    },
  });

  t.deepEqual(
    seen.map((entry) => entry.kind),
    ['MethodDeclaration', 'ReturnStatement'],
    'visitAst reaches method and return nodes in source order',
  );
  t.ok(seen[0].path.includes('typeDeclarations.0.body.0'), 'method path identifies its owning member slot');
  t.end();
});

test('Java frontend transform pass replaces nodes', (t) => {
  const document = makeLiteralReturnDocument(1);
  const manager = new frontend.JavaAstPassManager({
    passes: [
      {
        name: 'test.bumpNumericLiterals',
        phase: 'transform',
        transform: true,
        visitor: {
          leave(node) {
            if (node.kind === 'LiteralExpression' && node.literalKind === 'number') {
              return frontend.literalExpression(node.value + 1, 'number', String(node.value + 1));
            }
            return undefined;
          },
        },
      },
    ],
  });

  const transformed = manager.run(document, { validateAfterEach: true });
  const expression = transformed.root.typeDeclarations[0].body[0].body.statements[0].expression;
  t.equal(expression.value, 2, 'transform visitor replaced the numeric literal');
  t.equal(expression.raw, '2', 'replacement node is attached in the original tree position');
  t.end();
});

test('Java frontend transform pass can remove nodes from arrays', (t) => {
  const document = frontend.createAstDocument(
    frontend.compilationUnit({
      typeDeclarations: [
        frontend.classDeclaration('A', {
          body: [
            frontend.methodDeclaration('f', frontend.voidType(), {
              body: frontend.blockStatement([
                frontend.createNode('EmptyStatement', {}),
                frontend.returnStatement(null),
              ]),
            }),
          ],
        }),
      ],
    }),
  );

  frontend.transformAst(document, {
    leave(node) {
      if (node.kind === 'EmptyStatement') {
        return frontend.REMOVE_NODE;
      }
      return undefined;
    },
  });

  const statements = document.root.typeDeclarations[0].body[0].body.statements;
  t.equal(statements.length, 1, 'empty statement was removed from the block statement array');
  t.equal(statements[0].kind, 'ReturnStatement', 'remaining statement stays in place');
  t.end();
});

test('Java frontend pass manager resolves dependencies and records pass results', (t) => {
  const document = makeLiteralReturnDocument(1);
  const order = [];
  const manager = new frontend.JavaAstPassManager();

  manager.register({
    name: 'test.second',
    dependsOn: ['test.first'],
    run(astDocument, context) {
      order.push('second');
      context.annotate(astDocument.root, 'test.order.second', order.slice());
      return astDocument;
    },
  });
  manager.register({
    name: 'test.first',
    run(astDocument, context) {
      order.push('first');
      context.annotate(astDocument.root, 'test.order.first', order.slice());
      return astDocument;
    },
  });

  const result = manager.runWithResult(document, {
    include: ['test.second'],
    recordHistory: true,
    validateAfterEach: true,
  });

  t.deepEqual(order, ['first', 'second'], 'dependency pass runs before the requested pass');
  t.deepEqual(result.results.map((entry) => entry.name), ['test.first', 'test.second'], 'run result lists executed passes');
  t.deepEqual(document.meta.passManager.runs.map((entry) => entry.name), ['test.first', 'test.second'], 'optional pass history is stored in document metadata');
  t.deepEqual(frontend.getNodeAnnotation(document.root, 'test.order.second'), ['first', 'second'], 'passes can annotate nodes through the context');
  t.end();
});


test('Java frontend pass manager can require explicitly selected dependencies', (t) => {
  const document = makeLiteralReturnDocument(1);
  const manager = new frontend.JavaAstPassManager({
    passes: [
      { name: 'test.required', run(astDocument) { return astDocument; } },
      { name: 'test.consumer', dependsOn: ['test.required'], run(astDocument) { return astDocument; } },
    ],
  });

  t.throws(
    () => manager.run(document, { include: ['test.consumer'], includeDependencies: false }),
    /dependency not selected: test.required/,
    'includeDependencies=false does not auto-add dependencies',
  );

  const result = manager.runWithResult(document, {
    include: ['test.required', 'test.consumer'],
    includeDependencies: false,
  });
  t.deepEqual(result.results.map((entry) => entry.name), ['test.required', 'test.consumer'], 'explicitly selected dependencies are allowed');
  t.end();
});

test('Java frontend built-in annotation passes assign node IDs and histograms', (t) => {
  const document = frontend.parseJava('class A { int x; int get() { return x; } }');
  const manager = new frontend.JavaAstPassManager({
    passes: [
      frontend.createAssignNodeIdsPass({ annotationKey: 'test.nodeId', prefix: 'node:' }),
      frontend.createNodeKindHistogramPass({ annotationKey: 'test.kindHistogram', dependsOn: ['frontend.assignNodeIds'] }),
    ],
  });

  manager.run(document, { validateAfterEach: true });
  const nodes = frontend.collectAstNodes(document);
  const ids = nodes.map((node) => frontend.getNodeAnnotation(node, 'test.nodeId'));
  const uniqueIds = new Set(ids);
  const histogram = frontend.getNodeAnnotation(document.root, 'test.kindHistogram');

  t.equal(ids.length, uniqueIds.size, 'assigned node IDs are unique');
  t.ok(ids.every((id) => typeof id === 'string' && id.startsWith('node:')), 'node IDs use the requested prefix');
  t.ok(histogram.CompilationUnit >= 1, 'histogram includes the compilation unit');
  t.ok(histogram.MethodDeclaration >= 1, 'histogram includes method declarations');
  t.doesNotThrow(() => frontend.deserializeAst(frontend.serializeAst(document)), 'annotated AST remains serializable');
  t.end();
});

test('Java frontend pass context can emit serializable diagnostics', (t) => {
  const document = makeLiteralReturnDocument(1);
  const manager = new frontend.JavaAstPassManager({
    passes: [
      {
        name: 'test.diagnostic',
        run(astDocument, context) {
          context.emitDiagnostic('TEST_DIAGNOSTIC', 'diagnostic from pass');
          return astDocument;
        },
      },
    ],
  });

  manager.run(document);
  t.equal(document.diagnostics.length, 1, 'diagnostic is appended to document diagnostics');
  t.equal(document.diagnostics[0].pass, 'test.diagnostic', 'diagnostic records the pass that emitted it');
  t.doesNotThrow(() => frontend.deserializeAst(frontend.serializeAst(document)), 'diagnostic remains serializable');
  t.end();
});
