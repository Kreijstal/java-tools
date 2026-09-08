'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const {newFields, makeObjectRef, denseSlotFor, writeField, readField} = require('../src/core/objectModel');

for (const wasmFields of [false, true]) {
 test(`dense fields retain Wasm read caching (wasmFields=${wasmFields})`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dense-wasm-cache-'));
  t.teardown(() => fs.rmSync(directory, {recursive:true, force:true}));
  execFileSync('javac', ['-g', '-d', directory,
   path.resolve(__dirname, '../sources/DenseWasmFieldLoop.java')]);
  const jvm = new JVM({classpath:directory, wasmHeap:true, wasmFields,
   denseInstanceFields:true, jit:{compileWorker:false, wasmStructured:true}});
  await jvm.preloadClasspathClasses();
  jvm.classInitializationState.set('DenseWasmFieldLoop', 'INITIALIZED');
  const fields = newFields(jvm, 'DenseWasmFieldLoop');
  t.ok(Array.isArray(fields), 'the selected object representation is dense');
  const object = makeObjectRef(jvm, 'DenseWasmFieldLoop', fields);
  const slot = denseSlotFor(jvm, 'DenseWasmFieldLoop', 'value', 'I');
  let reads = 0, value = 7;
  Object.defineProperty(fields, slot, {get() {reads++; return value;},
   set(next) {value=next;}, configurable:true});
  const invoke = async name => {
   const method = await jvm.findMethodInHierarchy('DenseWasmFieldLoop', name, '(I)I');
   const wasm = jvm.jit.wasmJit, state = wasm.methodState({method});
   wasm.compile({className:'DenseWasmFieldLoop',method}, state);
   t.equal(state.status, 'ready', `${name} compiles`);
   t.equal(state.meta?.structured, true, 'the structured backend is exercised');
   const frame = new Frame(method);frame.className='DenseWasmFieldLoop';
   frame.locals[0]=object;frame.locals[1]=10000;
   const thread={status:'runnable',callStack:new Stack()};thread.callStack.push(frame);
   const result=wasm.execute(frame,thread,state,0);
   t.equal(result.returned,true,'the compiled method returns');
   return state.meta.box.ret;
  };
  t.equal(await invoke('sum'),70000,'the result is exact');
  t.equal(reads,1,'a stable dense field crosses into JS only once, not per iteration');
  writeField(fields,'DenseWasmFieldLoop.value',0);
  t.equal(await invoke('mutate'),50005000,'writes invalidate or update the cached value');
  t.equal(readField(fields,'DenseWasmFieldLoop.value'),10000,'the final field value is exact');
  t.end();
 });
}
