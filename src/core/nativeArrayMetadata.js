'use strict';
// Metadata publication must not execute host getters before the Java array
// access. Only canonical views in the same memory supply native pointers.
const {allocationForArray}=require('./wasmHeap');
function writeNativeArrayHeader(memory,value,words,index) {
  words[index]=-1;words[index+1]=0;
  const allocation=allocationForArray(value);
  if(!allocation || allocation.memory!==memory || allocation.descriptor==='[Z')return;
  words[index]=allocation.base;words[index+1]=allocation.length;
}
function nativeArrayBase(memory,value) {
  const allocation=allocationForArray(value);
  if(allocation)return allocation.memory===memory && allocation.descriptor!=='[Z' &&
    value.type!=='[Z' && value.elementType!=='boolean' ? allocation.base:-1;
  // Existing checked accesses also support host-created aliases into this
  // memory. Unlike header publication, this query runs at the ordinary
  // metadata access point and validates the view's actual offset. Keep it
  // consistent with the bulk-copy representation check for overlapping views.
  return ArrayBuffer.isView(value) && value.buffer===memory.buffer &&
    Number.isInteger(value.wasmBase) && value.wasmBase===value.byteOffset &&
    value.type!=='[Z' && value.elementType!=='boolean' ? value.wasmBase:-1;
}
function hasOwnedArrayMetadata(memory,value) {
 const allocation=allocationForArray(value);
 return !!allocation && allocation.memory===memory && allocation.descriptor!=='[Z';
}
module.exports={writeNativeArrayHeader,nativeArrayBase,hasOwnedArrayMetadata};
