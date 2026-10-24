'use strict';

// Static reference cells have one canonical externref value. The adjacent
// native header describes only genuine arrays in the owning memory. Reads of
// customized cell properties retain the accessor path; no host getter runs
// early merely to derive optimization metadata.
const records=new WeakMap();
const data=descriptor=>descriptor && Object.hasOwn(descriptor,'value');
const {writeNativeArrayHeader}=require('./nativeArrayMetadata');
function words(record) {
  if(record.header.length!==4)record.header=new Int32Array(record.memory.buffer,record.address,4);
  return record.header;
}
function materialize(record) {
  if(record.active){
    Reflect.defineProperty(record.target,'value',{value:record.global.value});
    record.active=false;
  }
  if(record.memory)words(record)[0]=0;
}
function update(record,value) {
  if(!record.memory)return;
  const header=words(record);
  header[0]=0;header[1]=-1;header[2]=0;
  if(!record.valueData){record.active=false;record.global.value=undefined;return;}
  record.global.value=value;
  if(record.valueWritable)record.target.value=undefined;
  record.active=true;
  writeNativeArrayHeader(record.memory,value,header,1);
  header[0]=1+(record.valueWritable && record.presentData && record.target.present===true?2:0);
}
function refresh(record) {
  const value=Reflect.getOwnPropertyDescriptor(record.target,'value');
  const present=Reflect.getOwnPropertyDescriptor(record.target,'present');
  record.valueData=!!data(value);record.valueWritable=record.valueData && !!value.writable;
  record.presentData=!!data(present);record.presentWritable=record.presentData && !!present.writable;
  update(record,record.valueData?value.value:undefined);
}
function makeNativeStaticReferenceCell(value,present) {
  const record={target:{value,present},memory:null,active:false,
    valueData:true,valueWritable:true,presentData:true,presentWritable:true};
  let cell;
  cell=new Proxy(record.target,{
    get(target,key,receiver){return key==='value' && record.active?record.global.value:Reflect.get(target,key,receiver);},
    getOwnPropertyDescriptor(target,key){const descriptor=Reflect.getOwnPropertyDescriptor(target,key);
      return key==='value' && record.active && data(descriptor)?{...descriptor,value:record.global.value}:descriptor;},
    set(target,key,next,receiver){
      if(receiver===cell && key==='value' && record.valueWritable){target.value=next;update(record,next);return true;}
      if(receiver===cell && key==='present' && record.presentWritable){
        if(target.present===next)return true;
        materialize(record);target.present=next;update(record,record.valueData?target.value:undefined);return true;
      }
      if(key==='value'||key==='present')materialize(record);
      const result=Reflect.set(target,key,next,receiver);
      if(key==='value'||key==='present'){materialize(record);refresh(record);}
      return result;
    },
    defineProperty(target,key,descriptor){
      if(key==='value'||key==='present')materialize(record);
      const result=Reflect.defineProperty(target,key,descriptor);
      if(key==='value'||key==='present')refresh(record);return result;
    },
    deleteProperty(target,key){
      if(key==='value'||key==='present')materialize(record);
      const result=Reflect.deleteProperty(target,key);
      if(key==='value'||key==='present')refresh(record);return result;
    },
  });
  records.set(cell,record);return cell;
}
function bindNativeStaticReferenceCell(cell,heap) {
  const record=records.get(cell);
  if(!record || !heap?.memory || typeof heap.trackObject!=='function')return null;
  if(record.memory)return record.memory===heap.memory?record.binding:null;
  if(!Number.isInteger(heap.top) || heap.top<0 || heap.top>0x7ffffff0 ||
      typeof SharedArrayBuffer!=='undefined' && heap.memory.buffer instanceof SharedArrayBuffer)return null;
  const address=heap.allocObject(16);if(address<0)return null;
  if(!heap.trackObject(cell,address,16)){heap.free(address,16);return null;}
  record.memory=heap.memory;record.address=address;
  record.header=new Int32Array(record.memory.buffer,address,4);
  record.global=new WebAssembly.Global({value:'externref',mutable:true});
  record.binding={address,value:record.global};refresh(record);return record.binding;
}
module.exports={makeNativeStaticReferenceCell,bindNativeStaticReferenceCell};
