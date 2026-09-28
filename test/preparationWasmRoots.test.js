'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const fixture = require('./javaFixture').makeJavaFixtureCompiler('preparation-wasm-roots-');

test('Wasm preparation root filtering leaves execution selection and JS preparation unchanged', async t => {
 const classpath=fixture(t,'RootFilter',`public class RootFilter {
  static int leaf(int x) { return x + 1; }
  static int first(int n) { int sum=0; for(int i=0;i<n;i++)sum+=i; return sum; }
  static int second(int n) { int sum=0; for(int i=0;i<n;i++)sum+=i*2; return sum; }
 }`);
 const roots=['RootFilter.first(I)I','RootFilter.second(I)I'];
 for(const selected of [undefined,[],[roots[0]]]) {
  const j=new JVM({classpath,prepareBeforeMain:false,jit:{compileWorker:false,
   structuredSsa:true,rendererPipeline:true,compiledCallChains:true,
   wasmStructured:true,preparedWasmMethods:roots,
   wasm:{noOnDemandCalleeCompile:true}}});
  await j.preloadClasspathClasses();j._setClassInitializationState('RootFilter','INITIALIZED');
  j.jit.wasmJit.enabled=true;
  const policy={maxMethods:3,priorityMethods:[...roots,'RootFilter.leaf(I)I'],wasmCalleeMethods:['RootFilter.leaf(I)I']};
  if(selected!==undefined)policy.wasmRootMethods=selected;
  await j.precompileInitializedClasses({effectful:true,wasm:true,wasmPreparedUpgradesOnly:true,preparationPolicy:policy});
  for(let i=0;i<roots.length;i++){
   const m=await j.findMethodInHierarchy('RootFilter',i===0?'first':'second','(I)I');
   t.equal(j.jit.wasmJit.state.get(m)?.status==='ready',selected===undefined||selected.includes(roots[i]),'only requested automatic roots are compiled');
   t.ok(j.jit.preparedCodegenMethods.has(m),'JS body remains prepared');
   t.ok(j.jit.isPreparedWasmMethodSelected(m),'runtime tier preference is unchanged');
  }
  const leaf=await j.findMethodInHierarchy('RootFilter','leaf','(I)I');
  t.equal(j.jit.wasmJit.state.get(leaf)?.status,'ready','explicit callees remain independently prepared');
  for(const value of [null,true,'RootFilter.first(I)I',[null],['']]){
   let error;
   try{await j.precompileInitializedClasses({preparationPolicy:{wasmRootMethods:value}});}catch(e){error=e;}
   // null uses the shared identity-set convention (empty selection).
   if(value!==null)t.ok(error instanceof TypeError&&/wasmRootMethods/.test(error.message),'malformed root list rejected');
  }
 }
 t.end();
});
