'use strict';

const test = require('tape');
const frontend = require('../src/java-frontend');

function sampleDocument() {
  return frontend.parseJava('class A { int add(int a, int b) { return a + b; } }', { sourceLevel: 8 });
}

test('expected frontend pass definitions are unique and dependency-complete', (t) => {
  const definitions = frontend.getExpectedFrontendPassDefinitions();
  const names = new Set(definitions.map((definition) => definition.name));

  t.ok(definitions.length >= 50, 'pass catalog covers the planned frontend pipeline');
  t.equal(names.size, definitions.length, 'pass names are unique');
  t.doesNotThrow(() => frontend.validateExpectedFrontendPassDefinitions(), 'dependencies reference registered passes');
  t.ok(names.has('frontend.validateFrontendModel'), 'terminal umbrella validation pass exists');
  t.ok(names.has('frontend.joinJavaBytecodeCfg'), 'CFG join pass exists in the full catalog');
  t.end();
});

test('full expected frontend pass pipeline can run as stubs and records serializable state', (t) => {
  const document = sampleDocument();
  const passes = frontend.createFullFrontendPassPipeline({
    normalizeBytecodeCfg: {},
  });
  const result = new frontend.JavaAstPassManager({ passes }).runWithResult(document, {
    include: ['frontend.validateFrontendModel'],
    recordHistory: true,
    validateAfterEach: true,
  });

  const definitions = frontend.getExpectedFrontendPassDefinitions();
  const definitionNames = definitions.map((definition) => definition.name);
  const executedNames = result.results.map((entry) => entry.name);
  const state = frontend.getAttachedFrontendPassStubState(result.document);

  t.deepEqual(new Set(executedNames), new Set(definitionNames), 'terminal pass pulls in the complete expected pipeline');
  t.equal(executedNames[executedNames.length - 1], 'frontend.validateFrontendModel', 'terminal pass runs last');
  t.equal(result.document.meta.passManager.runs.length, definitions.length, 'pass manager history records every expected pass');
  t.equal(state.schema, frontend.FRONTEND_PASS_STUBS_SCHEMA_ID, 'pass-stub state has the expected schema');
  t.equal(state.runs.length, definitions.length, 'pass-stub state records every expected pass');
  t.doesNotThrow(() => frontend.validateFrontendPassStubState(state), 'pass-stub state validates');
  t.doesNotThrow(() => frontend.deserializeAst(frontend.serializeAst(result.document)), 'document with pass state is AST-serializable');

  t.ok(result.document.meta.javaFrontendSymbolTable, 'symbol-table stub sidecar exists');
  t.ok(result.document.meta.javaFrontendTypeModel, 'type-model stub sidecar exists');
  t.ok(result.document.meta.javaFrontendDataflow, 'dataflow stub sidecar exists');
  t.ok(result.document.meta.javaFrontendLowering, 'lowering stub sidecar exists');
  t.ok(result.document.meta.javaFrontendBytecodeIr, 'bytecode-IR stub sidecar exists');
  t.ok(frontend.getAttachedCfgDocument(result.document), 'Java CFG sidecar exists');
  t.ok(frontend.getAttachedBytecodeCfgDocument(result.document), 'bytecode CFG sidecar exists');
  t.ok(frontend.getAttachedCfgJoinDocument(result.document), 'CFG join sidecar exists');
  t.ok(frontend.getNodeAnnotation(result.document.root, 'frontend.passStatus.frontend.validateFrontendModel'), 'root is annotated with terminal pass status');
  t.end();
});

test('expected frontend pass factory can select a subset of stubs', (t) => {
  const passes = frontend.createExpectedFrontendPasses({
    include: [
      'frontend.normalizeAstDocument',
      'frontend.validateSyntaxTree',
      'frontend.validateAstSerializable',
    ],
  });
  const document = sampleDocument();
  const result = frontend.runAstPasses(document, passes, { validateAfterEach: true });
  const state = frontend.getAttachedFrontendPassStubState(result);

  t.deepEqual(
    state.runs.map((run) => run.name),
    ['frontend.normalizeAstDocument', 'frontend.validateSyntaxTree', 'frontend.validateAstSerializable'],
    'subset factory creates and records only selected pass stubs',
  );
  t.end();
});
