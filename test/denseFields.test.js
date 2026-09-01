'use strict';

const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const objectHandlers = require('../src/instructions/object');
const { addFieldImport } = require('../src/jit/wasmRuntimeImports');
const {
  newFields, readField, writeField,
} = require('../src/core/objectModel');

function field(name, descriptor) {
  return {
    type: 'field',
    field: { name, descriptor, flags: [], accessFlags: 0x0001 },
  };
}

function denseJvm() {
  const jvm = new JVM({
    denseInstanceFields: true,
    jit: { warmupThreshold: 0, profileMethods: false },
  });
  jvm.classes.DenseBase = {
    staticFields: new Map(),
    ast: { classes: [{
      className: 'DenseBase', superClassName: 'java/lang/Object',
      items: [field('value', 'I')],
    }] },
  };
  jvm.classes.DenseChild = {
    staticFields: new Map(),
    ast: { classes: [{
      className: 'DenseChild', superClassName: 'DenseBase',
      items: [field('other', 'I')],
    }] },
  };
  jvm.classInitializationState.set('DenseBase', 'INITIALIZED');
  jvm.classInitializationState.set('DenseChild', 'INITIALIZED');
  return jvm;
}

test('interpreter getfield and putfield preserve dense inherited storage', (t) => {
  const jvm = denseJvm();
  const object = {
    type: 'DenseChild', _className: 'DenseChild',
    fields: newFields(jvm, 'DenseChild'),
  };
  const method = {
    name: 'touch', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [], localsSize: '1', stackSize: '2', exceptionTable: [],
    } }],
  };
  const frame = new Frame(method);
  frame.className = 'DenseChild';
  const instruction = {
    arg: ['Field', 'DenseBase', ['value', 'I']],
  };

  frame.stack.push(object);
  frame.stack.push(37);
  objectHandlers.putfield(frame, instruction, jvm);
  t.equal(readField(object.fields, 'DenseBase.value'), 37,
    'putfield writes the inherited numeric slot');
  frame.stack.push(object);
  objectHandlers.getfield(frame, instruction, jvm);
  t.equal(frame.stack.pop(), 37, 'getfield reads the same numeric slot');
  t.end();
});

test('generated JavaScript reads and writes dense fields directly', (t) => {
  const jvm = denseJvm();
  const fieldRef = ['Field', 'DenseBase', ['value', 'I']];
  const method = {
    className: 'DenseChild', name: 'increment', descriptor: '()V',
    flags: [], attributes: [{ type: 'code', code: {
      codeItems: [
        'aload_0', 'aload_0', { op: 'getfield', arg: fieldRef },
        'iconst_1', 'iadd', { op: 'putfield', arg: fieldRef }, 'return',
      ].map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      localsSize: '1', stackSize: '3', exceptionTable: [],
    } }],
  };
  jvm.classes.DenseChild.ast.classes[0].items.push({ type: 'method', method });
  const object = {
    type: 'DenseChild', _className: 'DenseChild',
    fields: newFields(jvm, 'DenseChild'),
  };
  writeField(object.fields, 'DenseBase.value', 9);
  const frame = new Frame(method);
  frame.className = 'DenseChild';
  frame.locals[0] = object;
  const callStack = new Stack();
  callStack.push(frame);
  const generated = jvm.jit.getGeneratedFunction(method);
  const result = generated(frame, {
    id: 0, status: 'runnable', pendingException: null, callStack,
  }, jvm.jit, false);

  t.equal(result?.returned, true, 'generated method returns normally');
  t.equal(readField(object.fields, 'DenseBase.value'), 10,
    'generated getfield/putfield update the numeric slot');
  t.match(generated.toString(), /Array\.isArray\(fields\)/,
    'generated source contains the dense direct-slot guard');
  t.end();
});

test('Wasm field imports resolve dense slots for classes loaded after compile', (t) => {
  const jvm = new JVM({ denseInstanceFields: true });
  const functions = [];
  const registry = {
    importIndexByName: new Map(),
    addImport(name, params, results, fn) {
      functions.push(fn);
      return functions.length - 1;
    },
  };
  const instruction = {
    arg: ['Field', 'LateDense', ['value', 'I']],
  };
  const getter = addFieldImport(
    registry, jvm, instruction, false, true,
  );
  const setter = addFieldImport(
    registry, jvm, instruction, false, false,
  );
  t.equal(getter.idx, 0, 'getter compiles before the owner class is loaded');

  jvm.classes.LateDense = {
    staticFields: new Map(),
    ast: { classes: [{
      className: 'LateDense', superClassName: 'java/lang/Object',
      items: [field('value', 'I')],
    }] },
  };
  jvm.classEpoch += 1;
  const object = {
    type: 'LateDense', _className: 'LateDense',
    fields: newFields(jvm, 'LateDense'),
  };
  writeField(object.fields, 'LateDense.value', 23);
  t.equal(functions[getter.idx](object), 23,
    'late getter resolves the runtime field metadata');
  functions[setter.idx](object, 41);
  t.equal(readField(object.fields, 'LateDense.value'), 41,
    'late setter writes the resolved runtime numeric slot');
  t.end();
});
