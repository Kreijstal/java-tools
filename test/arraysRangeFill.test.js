'use strict';
const test=require('tape');
const fill=require('../src/jre/java/util/Arrays').staticMethods['fill([IIII)V'];
const {JVM}=require('../src/core/jvm');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const fixture=makeJavaFixtureCompiler('arrays-range-fill-');

test('int range fill preserves bounds, tails and exception ordering',t=>{
 for(const make of [values=>values.slice(),values=>Int32Array.from(values)]){
  for(const [from,to] of [[0,0],[0,4],[1,3],[4,4]]){
   const a=make([11,22,33,44]),expected=[11,22,33,44];
   for(let i=from;i<to;i++)expected[i]=-123;
   fill({},null,[a,from,to,-123]);
   t.deepEqual([...a],expected,'writes exactly the requested interval');
  }
  for(const [from,to,type] of [[3,2,'IllegalArgumentException'],[-1,-2,'IllegalArgumentException'],[-1,5,'ArrayIndexOutOfBoundsException'],[0,5,'ArrayIndexOutOfBoundsException'],[5,5,'ArrayIndexOutOfBoundsException']]){
   const a=make([11,22,33,44]);let error;
   try{fill({},null,[a,from,to,0]);}catch(e){error=e;}
   t.equal(error?.type,'java/lang/'+type,'Java range-check precedence');
   t.deepEqual([...a],[11,22,33,44],'invalid range makes no partial writes');
  }
 }
 for(const range of [[0,0],[5,-1]]){
  let error;try{fill({},null,[null,...range,0]);}catch(e){error=e;}
  t.equal(error?.type,'java/lang/NullPointerException','null wins over range errors');
 }
 const j=new JVM({wasmHeap:true,wasmHeapMb:1,jit:{compileWorker:false}}),a=j.wasmHeap.alloc('[I',5),base=a.wasmBase;
 a.fill(99);fill(j,null,[a,0,4,0]);
 t.deepEqual([...a],[0,0,0,0,99],'linear-heap tail remains intact');
 t.equal(a.wasmBase,base,'fill preserves backing identity');
 t.end();
});

test('range fill is callable from prepared Java and preserves caught exceptions',async t=>{
 const classpath=fixture(t,'RangeFill',`public class RangeFill {
  public static void main(String[] args) {
   int[] values={11,22,33,44};java.util.Arrays.fill(values,1,3,-7);
   for(int value:values)System.out.println(value);
   try{java.util.Arrays.fill(values,3,2,0);}catch(IllegalArgumentException e){System.out.println(1);}
   try{java.util.Arrays.fill(values,0,5,0);}catch(ArrayIndexOutOfBoundsException e){System.out.println(2);}
   try{java.util.Arrays.fill((int[])null,3,2,0);}catch(NullPointerException e){System.out.println(3);}
   for(int value:values)System.out.println(value);
  }
 }`);
 for(const heap of [false,true]){
  const out=[],j=new JVM({classpath,wasmHeap:heap,wasmHeapMb:1,jit:{compileWorker:false,structuredSsa:true}});
  j.jre={...j.jre,'java/io/PrintStream':{...j.jre['java/io/PrintStream'],methods:{...j.jre['java/io/PrintStream'].methods}}};
  j.registerJreMethods({'java/io/PrintStream':{'println(I)V':(_j,_o,args)=>out.push(args[0])}});
  await j.run('RangeFill');
  t.deepEqual(out,[11,-7,-7,44,1,2,3,11,-7,-7,44],'guest result and exception types match Java');
 }
 t.end();
});
