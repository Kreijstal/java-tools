'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const inputStream=require('../src/jre/java/io/InputStream');
const {EventEmitter}=require('node:events');

test('native I/O byte arrays are exact, signed, and never alias their source',async t=>{
 const j=new JVM({wasmHeap:true}),source=Buffer.from([0,127,128,255]);
 const a=j.newByteArray(source),b=j.newByteArray(source);
 t.equal(a.type,'[B','result remains a Java byte array');t.deepEqual([...a],[0,127,-128,-1],'signed narrowing is exact');
 t.notEqual(a,b,'separate native returns retain separate Java identities');
 source[0]=33;t.equal(a[0],0,'source mutation does not change returned Java bytes');
 a[1]=42;t.equal(source[1],127,'Java mutation does not change source bytes');t.equal(b[1],127,'separate Java arrays do not alias');
 const slice=new Uint8Array(source.buffer,source.byteOffset+2,2);
 t.deepEqual([...j.newByteArray(slice)],[-128,-1],'typed view offset and length are preserved');
 t.equal(j.newByteArray([]).length,0,'empty I/O arrays are valid');
 const stream=new EventEmitter(),promise=inputStream.methods['readAllBytes()[B'](j,{stream},[],{});
 stream.emit('data',Buffer.from([3,128]));stream.emit('data',Buffer.from([255]));stream.emit('end');
 const all=await promise;t.deepEqual([...all],[3,-128,-1],'InputStream returns the exact concatenated bytes');
 const legacy=new JVM({wasmHeap:false}).newByteArray(source);
 t.equal(legacy.type,'[B','heap-disabled representation is supported');t.deepEqual([...legacy.array],[33,127,-128,-1],'legacy wrapped bytes remain exact');
 j.wasmHeap.top=j.wasmHeap.limit;const fallback=j.newByteArray([1,2]);
 t.deepEqual([...fallback],[1,2],'heap exhaustion preserves fresh array contents');
 t.end();
});
