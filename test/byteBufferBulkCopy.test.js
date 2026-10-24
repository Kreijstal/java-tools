'use strict';
const test=require('tape');
const ByteBuffer=require('../src/jre/java/nio/ByteBuffer');
const allocate=n=>ByteBuffer.staticMethods['allocate(I)Ljava/nio/ByteBuffer;'](null,null,[n]);
const call=(name,obj,array)=>ByteBuffer.methods[name+'([B)Ljava/nio/ByteBuffer;'](null,obj,[array]);
const position='java/nio/Buffer/position',backing='java/nio/ByteBuffer/buffer';

test('ByteBuffer bulk transfers preserve byte values, slice offsets and positions',t=>{
 const obj=allocate(12),input=new Int8Array([-128,-1,0,127]),out=new Int8Array(6).fill(42);
 obj[position]=3;
 t.equal(call('put',obj,{type:'[B',array:input}),obj,'put returns same buffer');
 t.equal(obj[position],7,'put advances position');
 t.deepEqual([...obj[backing]],[0,0,0,128,255,0,127,0,0,0,0,0],'put preserves exact bits at nonzero offset');
 obj[position]=3;t.equal(call('get',obj,out.subarray(1,5)),obj,'get returns same buffer');
 t.deepEqual([...out],[42,-128,-1,0,127,42],'get preserves signed bytes and destination view bounds');
 t.equal(obj[position],7,'get advances position');
 const plain=[];plain.length=4;obj[position]=3;call('get',obj,plain);
 t.deepEqual(plain,[128,255,0,127],'legacy plain-array representation is unchanged');
 obj[position]=0;call('put',obj,[-129,256,13,7]);
 t.deepEqual([...obj[backing].subarray(0,4)],[127,0,13,7],'plain-array stores retain byte conversion');
 obj[position]=12;call('get',obj,new Int8Array(0));call('put',obj,new Int8Array(0));
 t.equal(obj[position],12,'empty transfer at limit is legal');
 t.end();
});

test('ByteBuffer bulk bounds failures transfer no bytes or position',t=>{
 for(const name of ['get','put']){
  const obj=allocate(4);obj[backing].set([1,2,3,4]);obj[position]=2;
  const array=new Int8Array([7,8,9]);let error;
  try{call(name,obj,array);}catch(e){error=e;}
  t.equal(error?.type,'java/nio/Buffer'+(name==='get'?'Underflow':'Overflow')+'Exception','exact guest bounds failure');
  t.equal(obj[position],2,'failure preserves position');
  t.deepEqual([...obj[backing]],[1,2,3,4],'failure preserves buffer contents');
  t.deepEqual([...array],[7,8,9],'failure preserves array contents');
 }
 t.end();
});

test('ByteBuffer bulk aliasing retains forward-copy behavior and host access order',t=>{
 const put=allocate(8);put[backing].set([1,2,3,4,5,6,7,8]);put[position]=2;
 call('put',put,new Int8Array(put[backing].buffer,put[backing].byteOffset,6));
 t.deepEqual([...put[backing]],[1,2,1,2,1,2,1,2],'forward-overlapping source keeps existing sequential behavior');
 const get=allocate(8);get[backing].set([1,2,3,4,5,6,7,8]);
 call('get',get,new Int8Array(get[backing].buffer,get[backing].byteOffset+2,6));
 t.deepEqual([...get[backing]],[1,2,1,2,1,2,1,2],'forward-overlapping destination keeps existing behavior');
 const before=allocate(8);before[backing].set([1,2,3,4,5,6,7,8]);before[position]=2;
 call('get',before,new Int8Array(before[backing].buffer,before[backing].byteOffset,6));
 t.deepEqual([...before[backing]],[3,4,5,6,7,8,7,8],'overlap toward lower addresses keeps exact result');
 const custom=allocate(3),events=[],source=[1,2,3];
 Object.defineProperty(source,0,{get(){events.push('read');return 5;}});
 call('put',custom,source);t.deepEqual([...custom[backing]],[5,2,3],'custom source values remain observable');
 t.deepEqual(events,['read'],'custom source getter executes once');
 let metadata=0;const typed=new Int8Array([4,5,6]);
 Object.defineProperty(typed,'buffer',{get(){metadata++;throw Error('not part of Java access');}});
 custom[position]=0;call('put',custom,typed);
 t.deepEqual([...custom[backing]],[4,5,6],'custom metadata keeps element path');t.equal(metadata,0,'custom metadata getter never runs');
 t.end();
});
