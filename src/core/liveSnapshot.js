'use strict';

// In-page save states: a snapshot of a running JVM, restored into that same
// JVM. Nothing is serialized. The snapshot holds the guest's objects by
// identity and records what each one contained, so a restore writes the
// contents back in place. Canvases, audio, classes and compiled code are never
// touched: they are the same objects before and after.
//
// Both operations run at a scheduler safepoint between ticks, and a snapshot
// waits for one where no thread has a frame in the closed module that cannot
// leave it. Primitive fields and arrays live in linear memory, which is copied
// whole; everything else is reached from the threads and statics.

const Frame = require('./frame');

const FRAME_FIELDS = ['className', 'pc', 'initializingClassName', 'monitorObject', 'monitorEntered',
  'monitorOwnerThreadId', 'jitGeneratedReturnParent', 'jitGeneratedReturnType', 'closedLoopPc'];
// Program structure and host handles: same object before and after.
const OPAQUE_KEYS = new Set(['_ast', 'ast', '_classData', 'classData', 'constantPool', 'attributes', 'method',
  'callStack', 'nativeThread', '_awtComponent', '_awtGraphics', '_canvasElement', 'audioOutput', 'fileHandle', 'writer',
  // Records of what the host has done, kept on guest objects. Rewinding one
  // asserts something untrue about the browser: a restored _presentScheduled
  // promises a requestAnimationFrame callback that does not exist, and every
  // later frame coalesces into it and is never shown.
  '_presentScheduled', '_presentToken', '_presentImageData', '_presentPixels32', '_presentWebGl', '_presentedVersion', '_pixelsVersion',
  '_lastCompletedAt', 'drainModel']);

const isGuestContainer = (value) => typeof value.type === 'string' || value._slabKeys !== undefined;

function tracked(value) {
  if (value === null || typeof value !== 'object' || value instanceof String) return false;
  if (Array.isArray(value) || value instanceof Map || value instanceof Set) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || isGuestContainer(value);
}

class Recorder {
  constructor(heap) {
    this.records = new Map();
    this.pending = [];
    this.buffer = heap ? heap.memory.buffer : null;
  }

  visit(value) {
    if (value === null || typeof value !== 'object' || this.records.has(value)) return;
    if (ArrayBuffer.isView(value)) {
      // A view of linear memory is covered by the memory copy.
      if (value.buffer !== this.buffer) this.records.set(value, { view: value.slice() });
      return;
    }
    if (!tracked(value)) return;
    this.records.set(value, null);
    this.pending.push(value);
  }

  drain() {
    while (this.pending.length) {
      const value = this.pending.pop();
      this.records.set(value, this.record(value));
    }
  }

  record(value) {
    if (Array.isArray(value)) {
      const items = Array.from(value);
      items.forEach((item) => this.visit(item));
      return { items };
    }
    if (value instanceof Map) {
      const entries = [...value.entries()];
      for (const [key, item] of entries) { this.visit(key); this.visit(item); }
      return { entries };
    }
    if (value instanceof Set) {
      const members = [...value];
      members.forEach((item) => this.visit(item));
      return { members };
    }
    const props = [];
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.writable || OPAQUE_KEYS.has(key)) continue;
      props.push([key, descriptor.value]);
      this.visit(descriptor.value);
    }
    // Declared fields are accessors on the class's prototype.
    const slabs = [];
    for (const key of value._slabKeys || []) {
      const item = value[key];
      slabs.push([key, item]);
      this.visit(item);
    }
    return { props, slabs };
  }
}

function restoreRecord(value, record) {
  if (record.view) { value.set(record.view); return; }
  if (record.items) {
    const { items } = record;
    for (let i = 0; i < items.length; i++) value[i] = items[i];
    if (value.length !== items.length) value.length = items.length;
    return;
  }
  if (record.entries) {
    value.clear();
    for (const [key, item] of record.entries) value.set(key, item);
    return;
  }
  if (record.members) {
    value.clear();
    for (const item of record.members) value.add(item);
    return;
  }
  const saved = new Set(record.props.map(([key]) => key));
  for (const key of Object.keys(value)) {
    if (saved.has(key) || OPAQUE_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.configurable && 'value' in descriptor) delete value[key];
  }
  for (const [key, item] of record.props) value[key] = item;
  for (const [key, item] of record.slabs) value[key] = item;
}

function frameState(frame) {
  const state = { method: frame.method, locals: frame.locals.slice(), stack: frame.stack.items.slice() };
  for (const field of FRAME_FIELDS) state[field] = frame[field];
  return state;
}

function buildFrame(state) {
  const frame = new Frame(state.method);
  frame.locals = state.locals.slice();
  frame.stack.items = state.stack.slice();
  for (const field of FRAME_FIELDS) frame[field] = state[field];
  return frame;
}

function takeSnapshot(jvm) {
  const heap = jvm.wasmHeap || null;
  const recorder = new Recorder(heap);
  const threads = jvm.threads.map((thread) => ({
    thread,
    frames: thread.callStack.items.map(frameState),
  }));
  recorder.visit(jvm.threads);
  for (const { frames } of threads) {
    for (const frame of frames) {
      frame.locals.forEach((value) => recorder.visit(value));
      frame.stack.forEach((value) => recorder.visit(value));
      recorder.visit(frame.monitorObject);
    }
  }
  const statics = [];
  for (const classData of Object.values(jvm.classes)) {
    const store = classData?.staticFields;
    if (!(store instanceof Map)) continue;
    const entries = [...store.entries()];
    entries.forEach(([, value]) => recorder.visit(value));
    statics.push({ store, entries });
  }
  for (const root of [jvm.stringPool, jvm.classObjectCache, jvm.invokedynamicCache]) if (root) recorder.visit(root);
  recorder.drain();
  return {
    format: 'jvmjs-live-snapshot',
    jvm,
    threads,
    statics,
    records: recorder.records,
    classInitializationState: [...jvm.classInitializationState],
    classInitializationOwners: [...(jvm.classInitializationOwners || [])],
    currentThreadIndex: jvm.currentThreadIndex,
    nextHashCode: jvm.nextHashCode,
    heap: heap ? heap.snapshot() : null,
  };
}

function restoreSnapshot(jvm, snapshot) {
  if (snapshot?.jvm !== jvm) throw new Error('A live snapshot restores only into the JVM that took it');
  if (jvm.wasmHeap) jvm.wasmHeap.restore(snapshot.heap);
  for (const [value, record] of snapshot.records) restoreRecord(value, record);
  for (const { store, entries } of snapshot.statics) {
    const saved = new Set(entries.map(([key]) => key));
    for (const key of [...store.keys()]) if (!saved.has(key)) store.delete(key);
    for (const [key, value] of entries) store.set(key, value);
  }
  // Threads started since are gone with the restored jvm.threads array. Frames
  // are built fresh: live ones are pooled, and a parked Wasm stack is simply
  // abandoned, since nothing will ever resume its promise.
  for (const { thread, frames } of snapshot.threads) {
    thread.callStack.items.length = 0;
    thread.closedEntryFrame = undefined;
    for (const state of frames) thread.callStack.push(buildFrame(state));
  }
  jvm.classInitializationState.clear();
  for (const [name, state] of snapshot.classInitializationState) jvm.classInitializationState.set(name, state);
  jvm._refreshClassInitializationTokens?.();
  jvm.classInitializationOwners = new Map(snapshot.classInitializationOwners);
  jvm.currentThreadIndex = Math.min(snapshot.currentThreadIndex, Math.max(0, jvm.threads.length - 1));
  jvm.nextHashCode = snapshot.nextHashCode;
}

module.exports = { takeSnapshot, restoreSnapshot, restoreRecord, Recorder };
