'use strict';
const test=require('tape');
const {compactBody,verifySpan}=require('../src/jit/CheckedSpanExperiment');
test('checked compact span: writes only on proven nonthrowing bounded path',t=>{
  const proof={maxCount:254,shift:1,mask:8355711};
  const kernel=new Function('tag,array,start,color,count','let completed=false;'+compactBody(proof)+';return completed;');
  for(const wrapped of [false,true])for(const count of [0,1,2,253,254])for(const color of [0,-1,2147483647]){
    const a=Int32Array.from({length:256},(_,i)=>(i*214013+0x7ffffff0)|0),expected=a.slice();
    for(let p=1;p<1+count;p++)expected[p]=(color+((expected[p]>>1)&8355711))|0;
    t.equal(kernel(-103,wrapped?{elements:a}:a,1,color,count),true,'bounded path admitted');
    t.deepEqual(a,expected,'exact signed integer pixels');
  }
  for(const [tag,start,count] of [[0,0,2],[-2,0,2],[-103,-1,2],[-103,1,256],[-103,0,255],[-103,0,-1],[-103,0,-2147483648],[-103,2147483647,2],[-103,0,1.5]]){
    const a=new Int32Array(256).fill(123),before=a.slice();
    t.equal(kernel(tag,a,start,7,count),false,'unsupported case falls back');
    t.deepEqual(a,before,'fallback has no partial writes');
  }
  for(const a of [null,[],new Float32Array(2),{elements:null}])t.equal(kernel(-103,a,0,7,1),false,'unsupported storage falls back');
  t.throws(()=>verifySpan({}, {descriptor:'()V',flags:[]},{}),/signature/,'unknown shape rejected');
  t.end();
});
