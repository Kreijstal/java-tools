'use strict';

const {OP,T,uleb,sleb} = require('../jit/wasmShared');
const {memoryForBuffer} = require('../core/wasmHeap');
const littleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
let swizzler;
let staging;
let externalModule;
const externalSwizzlers = new WeakMap();
const intPrototype = Int32Array.prototype, uintPrototype = Uint32Array.prototype;
const typedPrototype = Object.getPrototypeOf(intPrototype);
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype,'length').get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype,'buffer').get;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype,'byteOffset').get;

// The staging buffer belongs to the presenter, never to the guest. Convert
// four packed RGB integers at a time, then handle the final zero to three.
function swizzleModule(simd, external = false) {
  const section = (id,bytes) => [id,...uleb(bytes.length),...bytes];
  const get = n => [OP.local_get,n];
  const iconst = n => [OP.i32_const,...sleb(n)];
  const count = external ? 1 : 0, offset = external ? 2 : 1, limit = external ? 3 : 2;
  const input = () => [...get(offset),...(external ? [...get(0),OP.i32_add] : [])];
  const storeArg = align => external ? [align|0x40,1,0] : [align,0];
  const advance = n => [...get(offset),...iconst(n),OP.i32_add,OP.local_set,offset];
  const body = [1,2,T.i32]; // byte offset and exclusive byte limit
  if (simd) body.push(
    ...get(count),...iconst(-4),OP.i32_and,...iconst(2),OP.i32_shl,OP.local_set,limit,
    OP.block,0x40,OP.loop,0x40,
    ...get(offset),...get(limit),OP.i32_ge_u,OP.br_if,1,
    ...get(offset),...input(),0xfd,0,4,0,...input(),0xfd,0,4,0,
    0xfd,0x0d,2,1,0,3,6,5,4,7,10,9,8,11,14,13,12,15, // i8x16.shuffle
    0xfd,0x0c,0,0,0,255,0,0,0,255,0,0,0,255,0,0,0,255, // v128.const alpha
    0xfd,0x50,0xfd,0x0b,...storeArg(4), // v128.or; v128.store
    ...advance(16),OP.br,0,OP.end,OP.end);
  body.push(...get(count),...iconst(2),OP.i32_shl,OP.local_set,limit,
    OP.block,0x40,OP.loop,0x40,
    ...get(offset),...get(limit),OP.i32_ge_u,OP.br_if,1,
    ...get(offset),...iconst(-16777216),
    ...input(),OP.i32_load,2,0,...iconst(255),OP.i32_and,...iconst(16),OP.i32_shl,OP.i32_or,
    ...input(),OP.i32_load,2,0,...iconst(65280),OP.i32_and,OP.i32_or,
    ...input(),OP.i32_load,2,0,...iconst(16),OP.i32_shr_u,...iconst(255),OP.i32_and,OP.i32_or,
    OP.i32_store,...storeArg(2),...advance(4),OP.br,0,OP.end,OP.end,OP.end);
  return new Uint8Array([
    0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,external?2:1,...(external?[T.i32]:[]),T.i32,0]),
    ...(external ? section(2,[1,3,...stringBytes('env'),6,...stringBytes('source'),2,0,1]) : []),
    ...section(3,[1,0]),...section(5,[1,0,1]),
    ...section(7,[2,6,...stringBytes('memory'),2,external?1:0,7,...stringBytes('swizzle'),0,0]),
    ...section(10,[1,...uleb(body.length),...body]),
  ]);
}

function stringBytes(name) { return [...name].map(c => c.charCodeAt(0)); }

function getSwizzler() {
  if (swizzler !== undefined) return swizzler;
  swizzler = null;
  if (typeof WebAssembly === 'undefined') return swizzler;
  try {
    const vector = swizzleModule(true);
    const bytes = WebAssembly.validate(vector) ? vector : swizzleModule(false);
    swizzler = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
  } catch (_) { /* Packed JavaScript conversion remains available. */ }
  return swizzler;
}

function externalSource(source, count) {
  if (!ArrayBuffer.isView(source)) return null;
  const proto = Object.getPrototypeOf(source);
  // The old exact-size TypedArray.set path uses intrinsic element storage.
  // Leave custom length/subarray behavior to that path, without invoking new
  // getters during discovery of the owning memory.
  if ((proto !== intPrototype && proto !== uintPrototype) ||
      Object.hasOwn(source,'length') || Object.hasOwn(proto,'length') ||
      Object.getPrototypeOf(proto) !== typedPrototype ||
      Object.getOwnPropertyDescriptor(typedPrototype,'length')?.get !== typedLength ||
      typedLength.call(source) !== count) return null;
  const buffer = typedBuffer.call(source), memory = memoryForBuffer(buffer);
  return memory?.buffer === buffer ? memory : null;
}

function getExternalSwizzler(memory) {
  if (externalSwizzlers.has(memory)) return externalSwizzlers.get(memory);
  let state = null;
  try {
    if (externalModule === undefined) {
      externalModule = null;
      const vector = swizzleModule(true,true), scalar = swizzleModule(false,true);
      const bytes = WebAssembly.validate(vector) ? vector : scalar;
      if (WebAssembly.validate(bytes)) externalModule = new WebAssembly.Module(bytes);
    }
    if (externalModule) state = {native:new WebAssembly.Instance(externalModule,
      {env:{source:memory}}).exports, staging:null};
  } catch (_) { /* Unsupported multi-memory or allocation keeps staging. */ }
  externalSwizzlers.set(memory,state);
  return state;
}

function trySwizzleRgbToRgba32(output, pixels, count) {
  const source = pixels && pixels.elements ? pixels.elements : pixels;
  if (!littleEndian || count < 65536 || !Number.isInteger(count) ||
      count > 0x1fffffff || !(source instanceof Int32Array || source instanceof Uint32Array) ||
      source.length < count || !(output instanceof Uint32Array) || output.length < count) return false;
  let sourceMemory, external;
  try {
    sourceMemory = externalSource(source,count);
    external = sourceMemory && getExternalSwizzler(sourceMemory);
    const native = external ? external.native : getSwizzler();
    if (!native) return false;
    const memory = native.memory, required = count * 4;
    if (memory.buffer.byteLength < required)
      memory.grow(Math.ceil((required - memory.buffer.byteLength) / 65536));
    if (external) {
      if (!external.staging || external.staging.buffer !== memory.buffer || external.staging.length !== count)
        external.staging = new Uint32Array(memory.buffer,0,count);
      native.swizzle(typedOffset.call(source),count);
      output.set(external.staging);
    } else {
      if (!staging || staging.buffer !== memory.buffer || staging.length !== count)
        staging = new Uint32Array(memory.buffer,0,count);
      staging.set(source.length === count ? source : source.subarray(0,count));
      native.swizzle(count);
      output.set(staging);
    }
    return true;
  } catch (_) {
    if (external) externalSwizzlers.set(sourceMemory,null);
    else { swizzler = null; staging = null; }
    return false;
  }
}

// Packed Java RGB integers to opaque ImageData bytes. Callers can keep both
// views across frames; no frame-sized temporary JS array is created.
function copyRgbToRgba(pixels,rgba) {
  if (rgba.length !== pixels.length * 4) throw new RangeError('Wrong framebuffer size');
  if (littleEndian && ArrayBuffer.isView(rgba) && rgba.BYTES_PER_ELEMENT === 1 &&
      (rgba.byteOffset & 3) === 0) {
    const output = new Uint32Array(rgba.buffer,rgba.byteOffset,pixels.length);
    if (trySwizzleRgbToRgba32(output,pixels,pixels.length)) return;
    for (let i=0;i<pixels.length;i++) {
      const value=pixels[i];
      output[i]=0xff000000 | ((value >>> 16) & 255) | (value & 0xff00) | ((value & 255) << 16);
    }
    return;
  }
  for (let i=0,p=0;i<pixels.length;i++,p+=4) {
    const value=pixels[i];
    rgba[p]=(value >>> 16)&255;rgba[p+1]=(value >>> 8)&255;rgba[p+2]=value&255;rgba[p+3]=255;
  }
}

module.exports = {copyRgbToRgba,trySwizzleRgbToRgba32};
