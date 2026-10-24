'use strict';
const {getNativeObjectStorageOps,registerNativeReferenceArrayStorage,nativeReferenceArrayStorageOf}=require('./nativeObjectStorage');
const {writeNativeArrayHeader}=require('./nativeArrayMetadata');
const indexOf=key=>typeof key==='string' && /^(0|[1-9][0-9]*)$/.test(key)?Number(key):-1;

// Called only for a freshly allocated Java reference array, before it escapes.
// JS owns observable property semantics; the native mirror serves checked
// reads until any host customization revokes it. No global table roots arrays.
function makeNativeReferenceArray(jvm,array) {
  const heap=jvm.wasmHeap,ops=jvm.wasmFields && heap && getNativeObjectStorageOps();
  if(!ops || !Number.isInteger(heap.top) || heap.top<0 || heap.top>0x7ffffff0)return array;
  const bytes=8+array.length*8;
  if(!Number.isSafeInteger(bytes) || bytes>0x7ffffff0)return array;
  const base=heap.allocObject(bytes);if(base<0)return array;
  const classId=require('./objectModel').classIndexOf(jvm,array.type);
  // Negative bases distinguish a reference-array capability extent from an
  // ordinary object slab; -1 remains the missing-storage sentinel.
  const store=ops.create(-base-2,classId,array.length);
  if(!heap.trackObject(store,base,bytes)){heap.free(base,bytes);return array;}
  heap.i32[base>>2]=1;
  for(let i=0;i<array.length;i++){
    if(array[i]!==null)ops.setReference(store,i,array[i]);
    writeNativeArrayHeader(heap.memory,array[i],heap.i32,(base+8+i*8)>>2);
  }
  let active=true,proxy;
  const revoke=()=>{
    if(active){active=false;heap.i32[base>>2]=0;ops.clearReferences(store);}
  };
  proxy=new Proxy(array,{
    set(target,key,value,receiver){
      const index=indexOf(key);
      if(active && receiver===proxy && index>=0 && index<target.length){
        target[index]=value;ops.setReference(store,index,value);
        writeNativeArrayHeader(heap.memory,value,heap.i32,(base+8+index*8)>>2);return true;
      }
      if(index>=0 || key==='length' || key==='type' || key==='elementType')revoke();
      return Reflect.set(target,key,value,receiver);
    },
    defineProperty(target,key,descriptor){
      if(indexOf(key)>=0 || key==='length' || key==='type' || key==='elementType')revoke();
      return Reflect.defineProperty(target,key,descriptor);
    },
    deleteProperty(target,key){
      if(indexOf(key)>=0 || key==='length' || key==='type' || key==='elementType')revoke();
      return Reflect.deleteProperty(target,key);
    },
  });
  registerNativeReferenceArrayStorage(proxy,store,heap.memory);
  return proxy;
}
module.exports={makeNativeReferenceArray,nativeReferenceArrayStorageOf};
