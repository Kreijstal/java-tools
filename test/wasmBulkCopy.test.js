'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const {supportsWasmTryTable} = require('../src/jit/wasmShared');

for (const structured of [false, true]) {
 test(`bulk native stays in compiled execution (structured=${structured})`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-bulk-copy-'));
  t.teardown(() => fs.rmSync(directory, {recursive:true, force:true}));
  execFileSync('javac', ['-g', '-d', directory,
    path.resolve(__dirname, '../sources/WasmBulkCopy.java')]);
  const jvm = new JVM({classpath:directory, wasmHeap:true,
    jit:{compileWorker:false, wasmStructured:structured}});
  await jvm.preloadClasspathClasses();
  const wasm = jvm.jit.wasmJit;
  const method = await jvm.findMethodInHierarchy('WasmBulkCopy', 'copy', '([II[III)I');
  const state = wasm.methodState({method});
  // Compile cold: neither preparing the module nor taking its guard may copy.
  jvm.classInitializationState.delete('java/lang/System');
  wasm.compile({className:'WasmBulkCopy',method}, state);
  t.equal(state.status, 'ready', 'the method compiles');
  t.equal(state.meta?.normalFlowFullyCompiled, true, 'arraycopy does not demote its block');
  if (state.status !== 'ready') { t.end();return; }
  const invoke = (m, s, args) => {
    const frame = new Frame(m);frame.className='WasmBulkCopy';
    args.forEach((v,i) => frame.locals[i]=v);
    const thread={status:'runnable',callStack:new Stack()};thread.callStack.push(frame);
    const result=wasm.execute(frame,thread,s,0);
    return {result,frame,thread,value:s.meta.box.ret};
  };
  const target = new Int32Array([0,0,0,0]);
  const cold=invoke(method,state,[new Int32Array([3,4]),0,target,1,2]);
  t.notEqual(cold.result.returned,true,'cold System initialization exits');
  t.equal(cold.frame.pc,0,'the cold guard exits before block effects');
  t.deepEqual(Array.from(target),[0,0,0,0],'no copy happened during the cold exit');
  jvm.classInitializationState.set('java/lang/System','INITIALIZED');
  const warm=invoke(method,state,[new Int32Array([3,4]),0,target,1,2]);
  t.equal(warm.result.returned,true,'the same prepared module now returns');
  t.equal(warm.value,7,'the compiled loop observes the copied values');
  t.deepEqual(Array.from(target),[0,3,4,0],'destination is exact');
  jvm.classInitializationState.set('WasmBulkCopy','INITIALIZED');
  const drive=await jvm.findMethodInHierarchy('WasmBulkCopy','drive','([I[II)I');
  const driveState=wasm.methodState({method:drive});
  wasm.compile({className:'WasmBulkCopy',method:drive},driveState);
  t.equal(driveState.status,'ready','the linked caller compiles');
  const driven=invoke(drive,driveState,[new Int32Array([3,4]),new Int32Array(2),100]);
  t.equal(driven.result.returned,true,'bulk-copy helper does not strand its caller');
  t.equal(driven.value,700,'the entire compiled caller loop completes exactly');
  for (const typed of [false,true]) {
    const overlap=typed ? new Int32Array([1,2,3,4]) : [1,2,3,4];
    const forward=invoke(method,state,[overlap,0,overlap,1,3]);
    t.equal(forward.result.returned,true,'overlap stays compiled');
    t.deepEqual(Array.from(overlap),[1,1,2,3],'forward overlap uses original source');
    const backward=invoke(method,state,[overlap,1,overlap,0,3]);
    t.equal(backward.result.returned,true,'reverse overlap stays compiled');
    t.deepEqual(Array.from(overlap),[1,2,3,3],'backward overlap is exact');
  }
  // The wrapper's handlers are an EH-tier feature: without try_table the
  // guest exception leaves the compiled body as a host throw for the caller's
  // dispatcher, and there is no in-module handler exit to drive here.
  if (!supportsWasmTryTable()) {
    t.comment('engine without try_table: the exception wrapper is skipped');
    t.end();return;
  }
  const catches=await jvm.findMethodInHierarchy('WasmBulkCopy','caught','([I[II)I');
  const catchState=wasm.methodState({method:catches});
  wasm.compile({className:'WasmBulkCopy',method:catches},catchState);
  t.equal(catchState.status,'ready','the exception wrapper compiles');
  for (const [source,count,expected] of [[null,1,71],[[1],2,72],[[1],-1,72]]) {
    const caught=invoke(catches,catchState,[source,[0],count]);
    let steps=0;
    let returned=caught.value;
    while (!caught.thread.callStack.isEmpty() && ++steps<30) {
      const f=caught.thread.callStack.peek();
      const ins=f.instructions[f.pc++].instruction;
      if ((typeof ins === 'string' ? ins : ins?.op) === 'ireturn') returned=f.stack.peek();
      if (ins) await jvm.executeInstruction(ins,f,caught.thread);
    }
    t.ok(caught.thread.callStack.isEmpty(),'the Java handler completes');
    // An EH exit continues in the interpreter; capture its return operand
    // before the top-level frame is popped.
    t.equal(returned,expected,
      'the original Java exception reaches its matching handler');
  }
  t.end();
 });
}
