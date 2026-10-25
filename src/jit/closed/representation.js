'use strict';

// Closed-world guest storage.
//
// With `closedWorld` on, the VM owns every guest object, array and static
// field in a form both JavaScript and one Wasm module can address directly:
//
//   $obj  {base i32, cls i32, refs (ref $refs), wrapper externref}
//         primitive instance fields live in linear memory at `base`
//         (superclass-first offsets); reference fields live in `refs`.
//   $parr {base i32, len i32, kind i32, view externref}
//         a primitive array: the TypedArray view over linear memory is the
//         Java identity, the struct is its Wasm-side handle.
//   $rarr {elems (ref $refs), cls i32, wrapper externref}
//         a reference array: elements are owned natively; the JS array the
//         VM hands out is a Proxy reading and writing them.
//
// Inside Wasm every Java reference is an anyref: a guest object is its $obj,
// an array its $parr/$rarr, anything else (strings, JRE objects, foreign
// arrays) an internalized host value. toWasm/toJs convert at the boundary.
//
// Unlike the opt-in native storage elsewhere in the VM there are no
// certificates or revocation: host code reaches guest storage only through
// the named accessors installed here, so compiled code may trust it.

const { VT, OP, GC, ModuleBuilder, structType, arrayType, subType, refNull, ref } = require('./wasmBuilder');
// objectModel requires this module; resolve it lazily once, not per call.
let objectModel = null;
const classIndexOf = (jvm, name) => (objectModel ||= require('../../core/objectModel')).classIndexOf(jvm, name);

const STORE = Symbol('closed.store');
const BASE_KEY = '_wasmBase';
const KIND = { '[Z': 0, '[B': 1, '[C': 2, '[S': 3, '[I': 4, '[J': 5, '[F': 6, '[D': 7 };
const KIND_SHIFT = [0, 0, 1, 1, 2, 3, 2, 3];
const ELEMENT_TYPE = { '[Z': 'boolean', '[B': 'byte', '[C': 'char', '[S': 'short', '[I': 'int', '[J': 'long', '[F': 'float', '[D': 'double' };

// The shared rec group. Every closed module declares it first, so these type
// indices are identical across modules and canonicalize to the same types.
// $obj is non-final: a closed module declares one subtype of it per guest
// class, holding that class's reference fields.
const T_REFS = 'closed:0', T_OBJ = 'closed:1', T_PARR = 'closed:2', T_RARR = 'closed:3';
const OBJ_FIELDS = [{ type: VT.i32 }, { type: VT.i32 }, { type: ref(T_REFS) }, { type: VT.externref, mutable: true }];
function closedTypes() {
  return [
    arrayType(VT.anyref, true),
    subType([], structType(OBJ_FIELDS)),
    structType([{ type: VT.i32 }, { type: VT.i32 }, { type: VT.i32 }, { type: VT.externref }]),
    structType([{ type: ref(T_REFS) }, { type: VT.i32 }, { type: VT.externref, mutable: true }]),
  ];
}
const OBJ = { base: 0, cls: 1, refs: 2, wrapper: 3 };
const PARR = { base: 0, len: 1, kind: 2, view: 3 };
const RARR = { elems: 0, cls: 1, wrapper: 2 };

const get = (i) => [OP.local_get, i];
const castObj = (i) => [...get(i), ...GC.ref_cast, { stype: T_OBJ }];
const castRarr = (i) => [...get(i), ...GC.ref_cast, { stype: T_RARR }];
function helperModule() {
  const m = new ModuleBuilder();
  m.addRecGroup('closed', closedTypes());
  const A = VT.anyref, E = VT.externref, I = VT.i32;
  const def = (key, params, results, code) => {
    m.declareFunction(key, params.map((p) => [p]), results.map((r) => [r]));
    m.defineFunction(key, [], code);
    m.exportFunction(key, key);
  };
  def('newObj', [I, I, I], [A], [...get(0), ...get(1), ...get(2), ...GC.array_new_default, { type: T_REFS },
    OP.ref_null, VT.externref, ...GC.struct_new, { type: T_OBJ }]);
  def('setObjWrapper', [A, E], [], [...castObj(0), ...get(1), ...GC.struct_set, { type: T_OBJ }, OBJ.wrapper]);
  def('objGet', [A, I], [A], [...castObj(0), ...GC.struct_get, { type: T_OBJ }, OBJ.refs, ...get(1), ...GC.array_get, { type: T_REFS }]);
  def('objSet', [A, I, A], [], [...castObj(0), ...GC.struct_get, { type: T_OBJ }, OBJ.refs, ...get(1), ...get(2),
    ...GC.array_set, { type: T_REFS }]);
  def('objBase', [A], [I], [...castObj(0), ...GC.struct_get, { type: T_OBJ }, OBJ.base]);
  def('newParr', [I, I, I, E], [A], [...get(0), ...get(1), ...get(2), ...get(3), ...GC.struct_new, { type: T_PARR }]);
  def('newRarr', [I, I], [A], [...get(0), ...GC.array_new_default, { type: T_REFS }, ...get(1),
    OP.ref_null, VT.externref, ...GC.struct_new, { type: T_RARR }]);
  def('setRarrWrapper', [A, E], [], [...castRarr(0), ...get(1), ...GC.struct_set, { type: T_RARR }, RARR.wrapper]);
  def('rarrGet', [A, I], [A], [...castRarr(0), ...GC.struct_get, { type: T_RARR }, RARR.elems, ...get(1), ...GC.array_get, { type: T_REFS }]);
  def('rarrSet', [A, I, A], [], [...castRarr(0), ...GC.struct_get, { type: T_RARR }, RARR.elems, ...get(1), ...get(2),
    ...GC.array_set, { type: T_REFS }]);
  // toJs: null -> null; $obj/$rarr -> wrapper; $parr -> view; host -> itself.
  const test = (t) => [...get(0), ...GC.ref_test, { stype: t }];
  def('toJs', [A], [E], [
    ...get(0), OP.ref_is_null, OP.if, VT.externref, OP.ref_null, VT.externref,
    OP.else, ...test(T_OBJ), OP.if, VT.externref,
    ...get(0), ...GC.ref_cast, { stype: T_OBJ }, ...GC.struct_get, { type: T_OBJ }, OBJ.wrapper,
    OP.else, ...test(T_PARR), OP.if, VT.externref,
    ...get(0), ...GC.ref_cast, { stype: T_PARR }, ...GC.struct_get, { type: T_PARR }, PARR.view,
    OP.else, ...test(T_RARR), OP.if, VT.externref,
    ...get(0), ...GC.ref_cast, { stype: T_RARR }, ...GC.struct_get, { type: T_RARR }, RARR.wrapper,
    OP.else, ...get(0), ...GC.extern_convert_any,
    OP.end, OP.end, OP.end, OP.end,
  ]);
  return new WebAssembly.Instance(new WebAssembly.Module(m.build())).exports;
}

const indexOf = (key) => (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1);

function isStaticField(item) {
  const flags = item.field.flags;
  if (Array.isArray(flags) && flags.includes('static')) return true;
  return ((item.field.accessFlags || 0) & 0x0008) !== 0;
}
function slotKind(descriptor) {
  switch (descriptor) {
    case 'I': case 'S': case 'B': case 'C': case 'Z': return 'i32';
    case 'F': case 'D': return 'f64';
    case 'J': return 'i64';
    default: return null;
  }
}

class ClosedRuntime {
  constructor(jvm) {
    if (!jvm.wasmHeap) throw new Error('closedWorld requires the Wasm linear heap (wasmHeap)');
    this.jvm = jvm;
    this.heap = jvm.wasmHeap;
    this.ops = helperModule();
    this.layouts = new Map();
    this.adoptedArrays = 0;
    // Installed by the closed module: per-class allocators and per-field
    // accessors. Before that, objects are plain $obj with a refs array.
    this.classTypes = null;
    this.untypedObjects = 0;
    const ops = this.ops;
    this.toJs = (value) => (value === null ? null : ops.toJs(value));
  }

  toWasm(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' || typeof value === 'function') {
      const store = value[STORE];
      if (store !== undefined) return store;
      if (ArrayBuffer.isView(value)) {
        const parr = this.parrOf(value);
        return parr === value ? this.adoptArray(value) : parr;
      }
      if (Array.isArray(value)) return this.adoptArray(value);
    }
    return value;
  }

  // A Java array the VM built outside closed storage (JRE natives return
  // plain JS arrays, TypedArrays off the heap). Module code assumes every
  // array it sees is closed storage, so the array is copied into closed
  // storage when it first crosses in, and that store stays its identity for
  // all later crossings. A native that keeps mutating an array it already
  // handed out would not be seen by the guest; `adoptedArrays` counts them.
  adoptArray(value) {
    const type = value.type;
    if (typeof type !== 'string' || type[0] !== '[') return value;
    const length = value.length;
    let adopted;
    if (KIND[type] !== undefined) {
      adopted = this.heap.alloc(type, length);
      if (!adopted || adopted.buffer !== this.heap.memory.buffer) return value;
      for (let i = 0; i < length; i++) {
        const v = value[i];
        adopted[i] = type === '[J' ? BigInt(v ?? 0) : (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? 0));
      }
      adopted.type = type;
      adopted.elementType = value.elementType ?? ELEMENT_TYPE[type];
      adopted.cidx = classIndexOf(this.jvm, type);
    } else {
      const copy = new Array(length);
      for (let i = 0; i < length; i++) copy[i] = value[i] ?? null;
      copy.type = type;
      copy.elementType = value.elementType ?? (type.startsWith('[L') ? type.slice(2, -1) : type.slice(1));
      adopted = this.referenceArray(copy);
    }
    adopted.hashCode = value.hashCode ?? this.jvm.nextHashCode++;
    const store = adopted[STORE] ?? this.parrOf(adopted);
    Object.defineProperty(value, STORE, { value: store, configurable: true });
    this.adoptedArrays += 1;
    return store;
  }

  parrOf(view) {
    const cached = view[STORE];
    if (cached !== undefined) return cached;
    const kind = KIND[view.type];
    if (kind === undefined || view.wasmBase === undefined || view.buffer !== this.heap.memory.buffer) return view;
    const store = this.ops.newParr(view.wasmBase, view.length, kind, view);
    Object.defineProperty(view, STORE, { value: store });
    return store;
  }

  // Superclass-first layout of a guest class: primitive fields at fixed
  // offsets in linear memory, reference fields at fixed indices of `refs`.
  // An inherited field has the same offset/index in every subclass, so a
  // compiled field access needs only the declaring class.
  layout(className) {
    const jvm = this.jvm, classData = jvm.classes[className];
    if (!classData) return null;
    const epoch = jvm.classEpoch || 0;
    const cached = this.layouts.get(className);
    if (cached && cached.epoch === epoch && cached.classData === classData) return cached.layout;
    let layout = null;
    if (!(jvm.jre && jvm.jre[className] && !jvm.jre[className].applicationFallback)) {
      const chain = [];
      let current = className, complete = true;
      while (current) {
        const data = jvm.classes[current];
        const ast = data?.ast?.classes?.[0];
        if (!ast) { complete = false; break; }
        chain.unshift({ owner: current, items: ast.items.filter((item) => item.type === 'field' && !isStaticField(item)) });
        const superName = ast.superClassName;
        if (superName && !jvm.classes[superName]) {
          if (!jvm.jre || !jvm.jre[superName]) complete = false;
          break;
        }
        current = superName;
      }
      if (complete) {
        const slots = [], references = [];
        let offset = 0;
        for (const { owner, items } of chain) {
          const wide = [], narrow = [];
          for (const item of items) {
            const key = `${owner}.${item.field.name}`, kind = slotKind(item.field.descriptor);
            if (!kind) references.push({ key, owner, name: item.field.name, descriptor: item.field.descriptor, index: references.length });
            else (kind === 'i32' ? narrow : wide).push({ key, owner, name: item.field.name, descriptor: item.field.descriptor, kind });
          }
          for (const slot of [...wide, ...narrow]) {
            slots.push({ ...slot, offset });
            offset += slot.kind === 'i32' ? 4 : 8;
          }
          offset = (offset + 7) & ~7;
        }
        layout = { className, size: offset || 8, slots, references, keys: [...slots, ...references].map((f) => f.key) };
        layout.byKey = new Map([...slots, ...references].map((f) => [f.key, f]));
        layout.proto = this.buildProto(layout);
        layout.classId = classIndexOf(jvm, className);
      }
    }
    this.layouts.set(className, { epoch, classData, layout });
    return layout;
  }

  buildProto(layout) {
    const proto = {}, heap = this.heap, ops = this.ops, runtime = this;
    for (const slot of layout.slots) {
      let getter, setter;
      if (slot.kind === 'i32') {
        const index = slot.offset >> 2;
        getter = function () { return heap.i32[(this[BASE_KEY] >> 2) + index]; };
        setter = function (v) { heap.i32[(this[BASE_KEY] >> 2) + index] = v; };
      } else if (slot.kind === 'f64') {
        const index = slot.offset >> 3;
        getter = function () { return heap.f64[(this[BASE_KEY] >> 3) + index]; };
        setter = function (v) { heap.f64[(this[BASE_KEY] >> 3) + index] = v; };
      } else {
        const index = slot.offset >> 3;
        getter = function () { return heap.i64[(this[BASE_KEY] >> 3) + index]; };
        setter = function (v) { heap.i64[(this[BASE_KEY] >> 3) + index] = BigInt(v); };
      }
      Object.defineProperty(proto, slot.key, { get: getter, set: setter, enumerable: false, configurable: false });
    }
    for (const field of layout.references) {
      const index = field.index;
      Object.defineProperty(proto, field.key, {
        get() { return runtime.toJs(runtime.refGet(field, this[STORE])); },
        set(v) { runtime.refSet(field, this[STORE], runtime.toWasm(v)); },
        enumerable: false, configurable: false,
      });
    }
    Object.defineProperty(proto, BASE_KEY, { value: -1, writable: true, enumerable: false, configurable: false });
    Object.defineProperty(proto, '_slabKeys', { value: layout.keys, enumerable: false, configurable: false });
    return proto;
  }

  // A reference field of a closed object, by its layout entry.
  refGet(field, store) {
    const access = this.classTypes?.fields.get(field.key);
    return access ? access.get(store) : this.ops.objGet(store, field.index);
  }

  refSet(field, store, value) {
    const access = this.classTypes?.fields.get(field.key);
    if (access) access.set(store, value);
    else this.ops.objSet(store, field.index, value);
  }

  // The closed module's class types: every later instance of a guest class
  // is that class's struct.
  installClassTypes(classTypes) {
    if (this.untypedObjects) {
      throw new Error(`closed world: ${this.untypedObjects} guest objects were created before the module's class types`);
    }
    this.classTypes = classTypes;
  }

  // Field container for a fresh instance, or null when the class has no
  // closed layout (JRE classes, unresolved hierarchies) or the heap is spent.
  newFields(className) {
    const layout = this.layout(className);
    if (!layout) return null;
    let allocate = null;
    if (this.classTypes) {
      allocate = this.classTypes.alloc.get(className);
      if (!allocate) throw new Error(`closed world: no closed class type for ${className}`);
    }
    const base = this.heap.allocObject(layout.size);
    if (base < 0) return null;
    let store;
    if (allocate) store = allocate(base);
    else { store = this.ops.newObj(base, layout.classId, layout.references.length); this.untypedObjects += 1; }
    const fields = Object.create(layout.proto);
    Object.defineProperty(fields, BASE_KEY, { value: base, writable: false, enumerable: false });
    Object.defineProperty(fields, STORE, { value: store, enumerable: false });
    this.heap.trackObject?.(store, base, layout.size);
    return fields;
  }

  // Bind the Java wrapper to its store. Called once, by makeObjectRef.
  adoptWrapper(wrapper) {
    const store = wrapper.fields?.[STORE];
    if (store === undefined) return wrapper;
    wrapper[STORE] = store;
    this.ops.setObjWrapper(store, wrapper);
    return wrapper;
  }

  // Object.clone of a closed guest object: fresh storage, primitive bytes and
  // reference slots copied, wrapper expandos (JRE superclass state) copied.
  cloneObject(obj) {
    const store = obj && obj[STORE];
    if (store === undefined) return null;
    const layout = this.layout(obj.type);
    const fields = layout && this.newFields(obj.type);
    if (!fields) return null;
    const from = obj.fields[BASE_KEY], to = fields[BASE_KEY];
    new Uint8Array(this.heap.memory.buffer).copyWithin(to, from, from + layout.size);
    for (const field of layout.references) this.refSet(field, fields[STORE], this.refGet(field, store));
    const cloned = Object.assign({}, obj, {
      fields, hashCode: this.jvm.nextHashCode++, isLocked: false, lockOwner: null, lockCount: 0, waitSet: [],
    });
    cloned[STORE] = undefined;
    return this.adoptWrapper(cloned);
  }

  // A reference array whose elements live in a $rarr. The returned Proxy is
  // the Java identity; its target is a real Array (so Array.isArray holds)
  // carrying the VM's expandos (type, elementType, hashCode).
  referenceArray(array) {
    const ops = this.ops, runtime = this;
    const length = array.length;
    const cls = classIndexOf(this.jvm, array.type);
    const store = ops.newRarr(length, cls);
    for (let i = 0; i < length; i++) {
      if (array[i] !== null && array[i] !== undefined) ops.rarrSet(store, i, this.toWasm(array[i]));
      array[i] = null;
    }
    Object.defineProperty(array, STORE, { value: store, enumerable: false });
    const proxy = new Proxy(array, {
      get(target, key, receiver) {
        if (typeof key === 'string') {
          const index = indexOf(key);
          if (index >= 0) return index < length ? runtime.toJs(ops.rarrGet(store, index)) : undefined;
        }
        return Reflect.get(target, key, receiver);
      },
      set(target, key, value, receiver) {
        const index = indexOf(key);
        if (index >= 0 && index < length) { ops.rarrSet(store, index, runtime.toWasm(value)); return true; }
        return Reflect.set(target, key, value, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        const index = indexOf(key);
        if (index >= 0 && index < length) {
          return { value: runtime.toJs(ops.rarrGet(store, index)), writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      defineProperty(target, key, descriptor) {
        const index = indexOf(key);
        if (index >= 0 && index < length && Object.hasOwn(descriptor, 'value')) {
          ops.rarrSet(store, index, runtime.toWasm(descriptor.value));
          return true;
        }
        return Reflect.defineProperty(target, key, descriptor);
      },
    });
    ops.setRarrWrapper(store, proxy);
    return proxy;
  }

  // A static field cell whose value of record is a WebAssembly.Global that a
  // closed module imports directly.
  staticCell(key, value, present) {
    const descriptor = typeof key === 'string' ? key.slice(key.indexOf(':') + 1) : '';
    const runtime = this;
    let type;
    switch (descriptor) {
      case 'Z': case 'B': case 'C': case 'S': case 'I': type = 'i32'; break;
      case 'J': type = 'i64'; break;
      case 'F': type = 'f32'; break;
      case 'D': type = 'f64'; break;
      default: type = 'anyref';
    }
    const coerce = (v) => {
      if (type === 'anyref') return runtime.toWasm(v);
      if (v === undefined || v === null) return type === 'i64' ? 0n : 0;
      if (type === 'i64') return typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)));
      if (type === 'i32') return typeof v === 'boolean' ? (v ? 1 : 0) : v | 0;
      return Number(v);
    };
    // The value of record. A closed module defines its own global for each
    // static it uses and the cell rebinds to that export, so module code
    // reads a defined global instead of an imported one.
    let global = new WebAssembly.Global({ value: type, mutable: true }, coerce(value));
    const cell = {
      present: !!present,
      closedType: type,
      get closedGlobal() { return global; },
      rebind(next) {
        try { next.value = global.value; } catch (error) {
          throw new Error(`closed world: static ${key} holds a value its module global cannot: ${error.message}`);
        }
        global = next;
      },
      get value() { return type === 'anyref' ? runtime.toJs(global.value) : global.value; },
      set value(v) { global.value = coerce(v); },
    };
    return cell;
  }
}

module.exports = {
  ClosedRuntime, STORE, BASE_KEY, KIND, KIND_SHIFT, OBJ, PARR, RARR, OBJ_FIELDS,
  T_REFS, T_OBJ, T_PARR, T_RARR, closedTypes,
};
