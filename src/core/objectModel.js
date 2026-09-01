'use strict';

// The single definition of what a guest object *is*.
//
// Four call sites used to each carry their own copy of the "walk the class
// chain, default every declared field, build the wrapper literal" loop: the
// interpreter's `new` (instructions/object.js), the JS tier's allocateObject
// (jit/JitCompiler.js), the wasm tier's `new` import (jit/wasmRuntimeImports.js)
// and createAppletInstance (core/jvm.js). They had drifted in small ways (super
// loading awaited or not, malformed-AST guards present or not). Anything that
// wants to change the representation — a per-class field layout, a linear-memory
// slab — has to change it in one place, so they all route through here.

// JVM default value for a field of `descriptor`: 0 for the int-like kinds,
// 0n for long, 0.0 for float/double, null for references and arrays.
function defaultForDescriptor(descriptor) {
  switch (descriptor) {
    case 'I': case 'B': case 'S': case 'Z': case 'C': return 0;
    case 'J': return BigInt(0);
    case 'F': case 'D': return 0.0;
    default: return null;
  }
}

// Walk `className` and its loaded superclasses, oldest-first key order not
// guaranteed (insertion order is most-derived first, matching what every
// previous copy produced). Classes that are not loaded end the walk, so the
// map covers the guest prefix of the chain only — JRE superclass state lives
// in expandos on the wrapper, not in this map.
function instanceFieldTemplate(jvm, className) {
  const fields = {};
  let current = className;
  while (current) {
    const classData = jvm.classes[current];
    if (!classData || !classData.ast || !classData.ast.classes[0]) break;
    for (const item of classData.ast.classes[0].items) {
      if (item.type !== 'field') continue;
      fields[`${current}.${item.field.name}`] =
        defaultForDescriptor(item.field.descriptor);
    }
    current = classData.ast.classes[0].superClassName;
  }
  return fields;
}

// Dense guest-field metadata lives on the storage array itself. Symbols keep
// it out of guest enumeration, snapshots, and the Java array surface while
// allowing reflection/Unsafe and the interpreter to resolve a JVM field key
// without installing string-key accessors on Array.prototype (or on a custom
// array prototype). The latter shape was measurably hostile to SpiderMonkey.
const DENSE_FIELD_KEYS = Symbol('jvm.denseFieldKeys');
const DENSE_FIELD_SLOTS = Symbol('jvm.denseFieldSlots');

function computeDenseLayout(jvm, className) {
  const chain = [];
  let current = className;
  while (current) {
    // JRE superclass state is represented by wrapper expandos, exactly as in
    // instanceFieldTemplate. An exact JRE class keeps its existing field map
    // because native shims intentionally use named auxiliary entries there.
    if (jvm.jre && jvm.jre[current]) {
      if (current === className) return null;
      break;
    }
    const classData = jvm.classes[current];
    const classAst = classData?.ast?.classes?.[0];
    if (!classAst) return null;
    const declared = [];
    for (const item of classAst.items || []) {
      if (item?.type !== 'field' || isStaticField(item)) continue;
      declared.push({
        key: `${current}.${item.field.name}`,
        descriptor: item.field.descriptor,
      });
    }
    chain.unshift(declared);
    current = classAst.superClassName || null;
  }
  const entries = chain.flat();
  const keys = entries.map((entry) => entry.key);
  const slots = new Map(keys.map((key, index) => [key, index]));
  return { entries, keys, slots };
}

function denseLayoutFor(jvm, className) {
  if (!jvm.denseInstanceFields) return null;
  const classData = jvm.classes[className];
  if (!classData || jvm.jre && jvm.jre[className]) return null;
  const epoch = jvm.classEpoch || 0;
  if (classData._denseFieldLayout !== undefined &&
      classData._denseFieldLayoutEpoch === epoch) {
    return classData._denseFieldLayout;
  }
  classData._denseFieldLayoutEpoch = epoch;
  classData._denseFieldLayout = computeDenseLayout(jvm, className);
  return classData._denseFieldLayout;
}

function makeDenseFields(layout) {
  const fields = layout.entries.map((entry) =>
    defaultForDescriptor(entry.descriptor));
  Object.defineProperties(fields, {
    [DENSE_FIELD_KEYS]: { value: layout.keys },
    [DENSE_FIELD_SLOTS]: { value: layout.slots },
  });
  return fields;
}

// Resolve the numeric slot of a declared field. Superclass-first layout makes
// this slot identical in the declaring class and every dense guest subclass.
function denseSlotFor(jvm, owner, fieldName, descriptor) {
  if (!jvm.denseInstanceFields) return null;
  let current = owner;
  while (current) {
    const classData = jvm.classes[current];
    const classAst = classData?.ast?.classes?.[0];
    if (!classAst) return null;
    const declared = (classAst.items || []).some((item) =>
      item?.type === 'field' && !isStaticField(item) &&
      item.field?.name === fieldName &&
      (!descriptor || item.field?.descriptor === descriptor));
    if (declared) {
      const layout = denseLayoutFor(jvm, current);
      const slot = layout?.slots.get(`${current}.${fieldName}`);
      return Number.isInteger(slot) ? slot : null;
    }
    current = classAst.superClassName || null;
  }
  return null;
}

function denseFieldSlot(fields, key) {
  if (!Array.isArray(fields)) return null;
  const slot = fields[DENSE_FIELD_SLOTS]?.get(key);
  return Number.isInteger(slot) ? slot : null;
}

function readField(fields, key) {
  const slot = denseFieldSlot(fields, key);
  return slot === null ? fields[key] : fields[slot];
}

function writeField(fields, key, value) {
  const slot = denseFieldSlot(fields, key);
  if (slot !== null && value === undefined) {
    throw new Error(`Cannot store undefined in JVM instance field ${key}`);
  }
  fields[slot === null ? key : slot] = value;
  return value;
}

// Load the superclass chain so instanceFieldTemplate sees all of it. Only the
// async allocation paths (interpreter `new`, createAppletInstance) can do this;
// the compiled paths gate on the class being INITIALIZED, which implies its
// hierarchy is already resolved.
async function loadHierarchy(jvm, className) {
  let current = className;
  while (current) {
    const classData = jvm.classes[current];
    if (!classData || !classData.ast || !classData.ast.classes[0]) break;
    const superName = classData.ast.classes[0].superClassName;
    if (superName && !jvm.classes[superName]) {
      await jvm.loadClassByName(superName).catch(() => null);
    }
    current = superName;
  }
}

// The canonical wrapper. `fields` is passed in so callers that precompute a
// template (the wasm `new` import) can hand over a fresh clone without
// rebuilding it. Monitor state and identity hash live on the wrapper, never in
// the field map.
// Dense small integer per class name, handed to every object it creates. Guard
// and cast imports are called once or twice per iteration of a hot loop, and
// keying their memo by this integer instead of the class-name string is worth
// ~3 ns of the ~8 ns they cost: an array index beats a string-keyed Map lookup,
// and nothing crosses the wasm boundary as a string. Lives in the object
// literal below rather than being attached later, so guest objects keep the
// single hidden class that makes every read of it monomorphic.
function classIndexOf(jvm, className) {
  let indices = jvm._classIndices;
  if (!indices) { indices = jvm._classIndices = new Map(); }
  let index = indices.get(className);
  if (index === undefined) {
    index = indices.size;
    indices.set(className, index);
  }
  return index;
}

function makeObjectRef(jvm, className, fields) {
  return {
    type: className,
    _className: className,
    cidx: classIndexOf(jvm, className),
    fields,
    hashCode: jvm.nextHashCode++,
    isLocked: false,
    lockOwner: null,
    lockCount: 0,
    waitSet: [],
  };
}

// ---------------------------------------------------------------------------
// Slab-backed primitive instance fields (JVM_WASM_FIELDS=1, requires the wasm
// linear heap). Every getfield/putfield today costs a JS property access, and
// from compiled wasm it costs a call out through a `gf_`/`pf_` import — the
// import floor the loading reproducer is stuck on. Giving each object's
// primitive fields a fixed offset inside the wasm memory turns those into
// i32.load/i32.store with no boundary crossing.
//
// Representation: the object's `fields` still looks like a map keyed
// `Owner.name`, but for a slab-backed class it is `Object.create(proto)` where
// `proto` carries one accessor per primitive field reading/writing the slab at
// a static offset. Reference fields stay own data properties (Stage C would
// move them behind handles). Consequences callers must know about:
//   - `Object.keys(fields)` no longer lists primitive fields — use
//     enumerateFieldKeys(fields).
//   - `hasOwnProperty(fields, key)` is false for primitive fields — use
//     hasField(fields, key).
// Everything else — reads, writes, `in`, `!== undefined` guards — is unchanged.

const BASE_KEY = '_wasmBase';

// Slot kind per descriptor. int-like fields share a 4-byte i32 slot; float and
// double both get an f64 slot, which preserves today's semantics exactly (the
// JS map stores every float as a double, so narrowing to f32 here would be a
// behaviour change, not just a representation change); long gets an i64 slot
// and stays a BigInt at the JS boundary.
function slotKind(descriptor) {
  switch (descriptor) {
    case 'I': case 'S': case 'B': case 'C': case 'Z': return 'i32';
    case 'F': case 'D': return 'f64';
    case 'J': return 'i64';
    default: return null; // reference or array — not slab-backed
  }
}

function isStaticField(item) {
  const flags = item.field.flags;
  if (Array.isArray(flags) && flags.includes('static')) return true;
  return ((item.field.accessFlags || 0) & 0x0008) !== 0;
}

// Assign offsets for `className`'s primitive instance fields. Offsets are laid
// out SUPERCLASS FIRST, one 8-aligned block per class in the chain, 8-byte
// kinds before 4-byte ones within a block. That ordering is what makes a
// compile-time offset usable: a field declared by `Base` sits at the same
// offset in a `Base` instance and in every subclass instance, so a getfield
// site can bake in one constant regardless of the receiver's runtime class.
// Static fields are excluded — they live in classData.staticFields and only
// occupy dead entries in the plain field map today.
function computeLayout(jvm, className) {
  const chain = [];
  const refKeys = [];
  let current = className;
  while (current) {
    const classData = jvm.classes[current];
    if (!classData || !classData.ast || !classData.ast.classes[0]) return null;
    const wide = [];
    const narrow = [];
    for (const item of classData.ast.classes[0].items) {
      if (item.type !== 'field' || isStaticField(item)) continue;
      const key = `${current}.${item.field.name}`;
      const kind = slotKind(item.field.descriptor);
      if (!kind) refKeys.push(key);
      else if (kind === 'i32') narrow.push({ key, kind });
      else wide.push({ key, kind });
    }
    chain.unshift([...wide, ...narrow]);
    const superName = classData.ast.classes[0].superClassName;
    if (superName && !jvm.classes[superName]) {
      // A JRE superclass ends the guest prefix — its state lives in expandos
      // on the wrapper, exactly as instanceFieldTemplate already assumes. A
      // superclass that is neither loaded nor a JRE stub means the hierarchy
      // is still being resolved and no layout is knowable yet.
      if (!jvm.jre || !jvm.jre[superName]) return null;
      break;
    }
    current = superName;
  }
  const slots = [];
  let offset = 0;
  for (const block of chain) {
    for (const slot of block) {
      slots.push({ ...slot, offset });
      offset += slot.kind === 'i32' ? 4 : 8;
    }
    offset = (offset + 7) & ~7; // each class's block starts 8-aligned
  }
  return { size: offset || 8, slots, refKeys, keys: slots.map((s) => s.key) };
}

// Compile-time slot for the fieldref (`owner`.`fieldName`): resolves the
// declaring class, then reads the offset out of THAT class's layout. Thanks to
// superclass-first assignment the offset holds for every subclass instance, so
// compiled code can use it without knowing the receiver's runtime class — but
// only after checking that the receiver actually is slab-backed.
function slabSlotFor(jvm, owner, fieldName) {
  let current = owner;
  while (current) {
    const classData = jvm.classes[current];
    const classAst = classData && classData.ast && classData.ast.classes[0];
    if (!classAst) return null;
    const declares = classAst.items.some((item) => item.type === 'field' &&
      !isStaticField(item) && item.field.name === fieldName);
    if (declares) {
      const layout = slabLayoutFor(jvm, current);
      if (!layout) return null;
      return layout.slots.find((slot) => slot.key === `${current}.${fieldName}`)
        || null;
    }
    current = classAst.superClassName;
  }
  return null;
}

// Prototype carrying the accessors, built once per class.
function buildProto(jvm, layout) {
  const proto = {};
  const heap = jvm.wasmHeap;
  for (const slot of layout.slots) {
    const { offset, kind } = slot;
    let get;
    let set;
    if (kind === 'i32') {
      const index = offset >> 2;
      get = function () { return heap.i32[(this[BASE_KEY] >> 2) + index]; };
      set = function (v) { heap.i32[(this[BASE_KEY] >> 2) + index] = v; };
    } else if (kind === 'f64') {
      const index = offset >> 3;
      get = function () { return heap.f64[(this[BASE_KEY] >> 3) + index]; };
      set = function (v) { heap.f64[(this[BASE_KEY] >> 3) + index] = v; };
    } else {
      const index = offset >> 3;
      get = function () { return heap.i64[(this[BASE_KEY] >> 3) + index]; };
      set = function (v) { heap.i64[(this[BASE_KEY] >> 3) + index] = BigInt(v); };
    }
    Object.defineProperty(proto, slot.key, { get, set, enumerable: false, configurable: false });
  }
  Object.defineProperty(proto, BASE_KEY, {
    value: -1, writable: true, enumerable: false, configurable: false,
  });
  Object.defineProperty(proto, '_slabKeys', {
    value: layout.keys, enumerable: false, configurable: false,
  });
  return proto;
}

// Layout + prototype for `className`, cached on its classData. Returns null
// when the class is not slab-eligible (heap off, hierarchy not fully loaded).
function slabLayoutFor(jvm, className) {
  if (!jvm.wasmFields || !jvm.wasmHeap) return null;
  const classData = jvm.classes[className];
  if (!classData) return null;
  // Classes with a JRE stub keep the plain map: their stubs read and write
  // `fields` by enumeration and by expando mirrors, neither of which survives
  // the accessor representation.
  if (jvm.jre && jvm.jre[className]) return null;
  // A null result is cached against the class epoch, so a class that was not
  // yet layable becomes eligible once its hierarchy finishes loading.
  const epoch = jvm.classEpoch || 0;
  if (classData._slabLayout !== undefined && classData._slabEpoch === epoch) {
    return classData._slabLayout;
  }
  const layout = computeLayout(jvm, className);
  classData._slabEpoch = epoch;
  classData._slabLayout = layout
    ? { ...layout, proto: buildProto(jvm, layout) } : null;
  return classData._slabLayout;
}

// Build the `fields` object for a slab-backed class, or null when the class is
// not eligible or the heap is spent (callers then fall back to a plain map).
function makeSlabFields(jvm, layout) {
  const base = jvm.wasmHeap.allocObject(layout.size);
  if (base < 0) return null;
  const fields = Object.create(layout.proto);
  fields[BASE_KEY] = base;
  for (const key of layout.refKeys) fields[key] = null;
  return fields;
}

// Does `fields` define `key` as one of its own class's fields? Replaces
// hasOwnProperty for callers that must work with slab-backed objects. Only
// slab prototypes are consulted beyond own properties, so a plain field map
// can never accidentally match an Object.prototype member.
function hasField(fields, key) {
  if (denseFieldSlot(fields, key) !== null) return true;
  if (Object.prototype.hasOwnProperty.call(fields, key)) return key !== BASE_KEY;
  const proto = Object.getPrototypeOf(fields);
  return !!(proto && proto._slabKeys &&
    Object.prototype.hasOwnProperty.call(proto, key));
}

// Every field key on `fields`, slab-backed and plain alike.
function enumerateFieldKeys(fields) {
  if (Array.isArray(fields) && fields[DENSE_FIELD_KEYS]) {
    return [...fields[DENSE_FIELD_KEYS]];
  }
  const own = Object.keys(fields).filter((k) => k !== BASE_KEY);
  const proto = Object.getPrototypeOf(fields);
  const slabKeys = proto && proto !== Object.prototype && proto._slabKeys;
  return slabKeys ? own.concat(slabKeys) : own;
}

// The field map for a fresh instance: slab-backed when the class is eligible,
// otherwise the plain defaulted map. Every allocation site calls this.
function newFields(jvm, className) {
  const denseLayout = denseLayoutFor(jvm, className);
  if (denseLayout) return makeDenseFields(denseLayout);
  const layout = slabLayoutFor(jvm, className);
  if (layout) {
    const fields = makeSlabFields(jvm, layout);
    if (fields) return fields;
  }
  return instanceFieldTemplate(jvm, className);
}

module.exports = {
  defaultForDescriptor,
  instanceFieldTemplate,
  newFields,
  loadHierarchy,
  makeObjectRef,
  classIndexOf,
  slotKind,
  slabLayoutFor,
  slabSlotFor,
  makeSlabFields,
  hasField,
  enumerateFieldKeys,
  denseLayoutFor,
  denseSlotFor,
  denseFieldSlot,
  readField,
  writeField,
  makeDenseFields,
  DENSE_FIELD_KEYS,
  DENSE_FIELD_SLOTS,
  BASE_KEY,
};
