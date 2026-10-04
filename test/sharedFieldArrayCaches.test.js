"use strict";
const test = require("tape");
const {makeJavaFixtureCompiler} = require("./javaFixture");
const {JVM} = require("../src/core/jvm");
const Frame = require("../src/core/frame");
const compileFixture = makeJavaFixtureCompiler("shared-field-arrays-");
const SOURCE = `public class FieldArrays {
  static int[] data;
  int[] member;
  public static int same() { return data[0] + data[1] + data[2]; }
  public static int capture(int[] replacement) {
    int[] old = data; int result = old[0]; data = replacement;
    int[] fresh = data;
    return result + fresh[0] + old[1] + fresh[1];
  }
  public static int exchange(int[] a, int[] b, int n) {
    int result=0;
    for(int i=0;i<n;i++) {
      data=a; int[] old=data; result+=old[0];
      data=b; int[] fresh=data;
      result+=fresh[0]+old[1]+fresh[1];
    }
    return result;
  }
  public static int instance(FieldArrays owner, int[] replacement) {
    int[] old=owner.member; int result=old[0];
    owner.member=replacement; int[] fresh=owner.member;
    return result+fresh[0]+old[1]+fresh[1];
  }
  public static int writes() { data[0]=data[1]+7; return data[0]+data[2]; }
}`;

async function harness(t, enabled=true) {
  const classpath=compileFixture(t,"FieldArrays",SOURCE);
  const j=new JVM({classpath,wasmHeap:true,wasmHeapMb:16,
    jit:{enabled:false,compileWorker:false,wasm:{structured:true,
      deepInline:false,sharedFieldArrayCaches:enabled}}});
  await j.loadClassByName("FieldArrays");j._markClassInitialized("FieldArrays");
  j.classes.FieldArrays.staticFieldsInitialized=true;
  const w=j.jit.wasmJit;w.enabled=true;w.importStatsEnabled=true;
  const array=values=>{const a=j.wasmHeap.alloc("[I",values.length);a.type="[I";a.set(values);return a;};
  const compile=(name,descriptor)=>{const method=j.findMethod(j.classes.FieldArrays,name,descriptor);
    const st=w.methodState({method});w.compile({method,className:"FieldArrays"},st,{asCallee:true});
    t.equal(st.status,"ready",name+" actually installs Wasm");
    t.ok(st.meta?.structured,name+" uses the structured backend");
    return {st,method};};
  const run=({st,method},...args)=>{const frame=new Frame(method);st.meta.box.frame=frame;
    const values=st.meta.paramSlots.map(p=>args[p.slot]);
    const status=st.run(...values,0,100000000);
    t.equal(status,-1,"raw Wasm completes without an interpreter handoff");
    return st.meta.box.ret;};
  return {j,w,array,compile,run};
}

test("sibling field readers share metadata while preserving element writes",async t=>{
  const h=await harness(t);const a=h.array([2,3,5]);h.j.classes.FieldArrays.staticFields.set("data:[I",a);
  const same=h.compile("same","()I");
  t.ok(same.st.meta.sharedFieldArrayCacheCount>0,"sibling readers have a shared metadata group");
  t.equal(h.run(same),10,"three sibling reads produce the exact sum");
  t.equal(same.st.meta.importStats.get("abase"),1,"one base query serves all sibling readers");
  t.equal(same.st.meta.importStats.get("alen0"),1,"one length query serves all sibling readers");
  const writes=h.compile("writes","()I");t.equal(h.run(writes),15,"aliased element stores retain order");
  t.deepEqual(Array.from(a),[10,3,5],"the original array receives the exact store");t.end();
});

test("captured arrays remain valid across static and instance field replacement",async t=>{
  const h=await harness(t);const a=h.array([2,3,5]),b=h.array([11,13]);
  h.j.classes.FieldArrays.staticFields.set("data:[I",a);
  const capture=h.compile("capture","([I)I");
  t.ok(capture.st.meta.sharedFieldArrayCacheCount>0,"replacement probe actually uses sharing");
  t.equal(h.run(capture,b),29,"old and fresh captures retain their own base and length");
  const exchange=h.compile("exchange","([I[II)I");
  t.equal(h.run(exchange,a,b,43),29*43,"each loop iteration distinguishes both field generations");
  const plain=Object.assign([17,19],{type:"[I"});
  t.equal(h.run(exchange,plain,a,19),41*19,"heap and plain array generations can alternate");
  const instance=h.compile("instance","(LFieldArrays;[I)I");
  const owner={type:"FieldArrays",fields:{"FieldArrays.member":a}};
  t.equal(h.run(instance,owner,b),29,"instance replacement preserves both captured references");
  t.end();
});

test("sharing is opt-in and preserves null and bounds failures",async t=>{
  const h=await harness(t,false);const same=h.compile("same","()I");
  t.equal(same.st.meta.sharedFieldArrayCacheCount||0,0,"default path retains separate caches");
  h.j.classes.FieldArrays.staticFields.set("data:[I",null);
  t.throws(()=>h.run(same),e=>e.type==="java/lang/NullPointerException","null retains the guest exception type");
  h.j.classes.FieldArrays.staticFields.set("data:[I",h.array([7]));
  t.throws(()=>h.run(same),e=>e.type==="java/lang/ArrayIndexOutOfBoundsException","bounds failures retain the guest exception type");
  t.end();
});
