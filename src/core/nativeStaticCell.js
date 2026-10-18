'use strict';

// One canonical integer value shared by JS cells and native field accesses.
// Descriptor changes revoke native access synchronously, before a host getter
// or setter can run. Wide/reference/legacy cells keep their ordinary storage.
// The 16-byte extent holds capability bits (read=1, write=2), i32 value,
// JS representation tag, and padding. Native writes select numeric tag zero.
// Other JS numbers keep their exact primitive property value until replaced.
const records=new WeakMap();
const data=d=>d && Object.prototype.hasOwnProperty.call(d,'value');
function view(record) {
  if(record.words.length!==4)record.words=new Int32Array(record.memory.buffer,record.address,4);
  return record.words;
}
function live(record) {
  if(!record.active)return record.target.value;
  const words=view(record);
  switch(words[2]){
    case 0:return words[1];
    case 1:return !!words[1];
    case 2:return null;
    case 3:return undefined;
    default:return record.target.value; // exact non-i32 JS number, including -0
  }
}
function materialize(record) {
  if(record.active){
    Reflect.defineProperty(record.target,'value',{value:live(record)});
    record.active=false;
  }
  if(record.memory)view(record)[0]=0;
}
function update(record,value) {
  if(!record.memory)return;
  const words=view(record),type=typeof value;
  const supported=record.valueData && (type==='number'||type==='boolean'||value===null||value===undefined);
  if(!supported){words[0]=0;record.active=false;return;}
  words[1]=value|0;
  words[2]=type==='boolean'?1:value===null?2:value===undefined?3:
    Object.is(value,value|0)?0:4;
  words[0]=1+(record.valueWritable && record.presentData && record.target.present===true?2:0);
  record.active=true;
}
function refresh(record) {
  const value=Reflect.getOwnPropertyDescriptor(record.target,'value');
  const present=Reflect.getOwnPropertyDescriptor(record.target,'present');
  record.valueData=!!data(value);record.valueWritable=record.valueData && !!value.writable;
  record.presentData=!!data(present);record.presentWritable=record.presentData && !!present.writable;
  update(record,record.valueData?value.value:undefined);
}
function makeNativeStaticCell(value,present) {
  const record={target:{value,present},memory:null,active:false,
    valueData:true,valueWritable:true,presentData:true,presentWritable:true};
  let cell;
  cell=new Proxy(record.target,{
    get(target,key,receiver){
      return key==='value' && record.active?live(record):Reflect.get(target,key,receiver);
    },
    getOwnPropertyDescriptor(target,key){
      const descriptor=Reflect.getOwnPropertyDescriptor(target,key);
      return key==='value' && record.active && data(descriptor)
        ? {...descriptor,value:live(record)}:descriptor;
    },
    set(target,key,next,receiver){
      if(receiver===cell && key==='value' && record.valueWritable){
        target.value=next;update(record,next);return true;
      }
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
      if(key==='value'||key==='present')refresh(record);
      return result;
    },
    deleteProperty(target,key){
      if(key==='value'||key==='present')materialize(record);
      const result=Reflect.deleteProperty(target,key);
      if(key==='value'||key==='present')refresh(record);
      return result;
    },
  });
  records.set(cell,record);
  return cell;
}

function bindNativeStaticCell(cell,heap) {
  const record=records.get(cell);
  if(!record || !heap?.memory || typeof heap.trackObject!=='function')return null;
  if(record.memory)return record.memory===heap.memory?{address:record.address}:null;
  // This protocol is single-threaded and its emitted constants are signed i32.
  if(!Number.isInteger(heap.top) || heap.top<0 || heap.top>0x7ffffff0 ||
      typeof SharedArrayBuffer!=='undefined' && heap.memory.buffer instanceof SharedArrayBuffer)return null;
  const address=heap.allocObject(16);
  if(address<0)return null;
  if(!heap.trackObject(cell,address,16)){heap.free(address,16);return null;}
  record.memory=heap.memory;record.address=address;
  record.words=new Int32Array(record.memory.buffer,address,4);
  refresh(record);
  return {address};
}
module.exports={makeNativeStaticCell,bindNativeStaticCell};
