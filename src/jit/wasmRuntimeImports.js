'use strict';

// Wasm↔JS boundary import builders shared by the wasm backends. A registry is
// any object with addImport(name, params, results, fn) -> importIndex and an
// importIndexByName Map (MethodTranslator satisfies this; so does the
// structured backend's registry). Closures capture the per-module `box`
// ({frame, ret}) that execute() repoints at the live frame each run.
//
// The logic mirrors MethodTranslator's runtimeImports/arrayImports/
// fieldImports/mathIntrinsic byte-for-byte in behavior; the translator still
// carries its own copies until its strangler step lands.

const {
  resolveInstanceFieldKey, allocPrimitiveArray, allocReferenceArray,
} = require('../instructions/object');
const {
  T, NPE, AIOOBE, MATH_INTRINSICS, Unsupported,
  descToWasm, toWasmValue, parseMethodDescriptor,
} = require('./wasmShared');
const monoArray = require('./monoArray');

function addRuntimeImports(reg, box) {
  reg.addImport('push_i', [T.i32], [], (v) => { box.frame.stack.push(v); });
  reg.addImport('push_l', [T.i64], [], (v) => { box.frame.stack.push(v); });
  reg.addImport('push_f', [T.f32], [], (v) => { box.frame.stack.push(Math.fround(v)); });
  reg.addImport('push_d', [T.f64], [], (v) => { box.frame.stack.push(v); });
  reg.addImport('push_r', [T.ref], [], (v) => { box.frame.stack.push(v); });
  reg.addImport('ref_eq', [T.ref, T.ref], [T.i32], (a, b) => a === b ? 1 : 0);
  reg.addImport('ret_i', [T.i32], [], (v) => { box.ret = v; });
  reg.addImport('ret_l', [T.i64], [], (v) => { box.ret = v; });
  reg.addImport('ret_f', [T.f32], [], (v) => { box.ret = Math.fround(v); });
  reg.addImport('ret_d', [T.f64], [], (v) => { box.ret = v; });
  reg.addImport('ret_r', [T.ref], [], (v) => { box.ret = v; });
  reg.addImport('err_div0', [], [], () => {
    throw { type: 'java/lang/ArithmeticException', message: '/ by zero' };
  });
}

function pushImportFor(reg, t) {
  switch (t) {
    case T.i32: return reg.importIndexByName.get('push_i');
    case T.i64: return reg.importIndexByName.get('push_l');
    case T.f32: return reg.importIndexByName.get('push_f');
    case T.f64: return reg.importIndexByName.get('push_d');
    default: return reg.importIndexByName.get('push_r');
  }
}

function addArrayImports(reg, methodName) {
  const mk = (suffix, t) => {
    // monoArray keeps each backing class (plain Array vs wasm-heap TypedArray
    // views) on its own monomorphic keyed IC — one shared `a[i]` site over
    // that mix goes megamorphic and dominates the profile.
    const load = t === T.i32
      ? (a, i) => {
        if (a === null || a === undefined) throw NPE(`Attempted load on null array in ${methodName}`);
        const value = monoArray.load(a, i);
        if (value === monoArray.OOB) throw AIOOBE(i, monoArray.len(a));
        return typeof value === 'boolean' ? (value ? 1 : 0) : value;
      }
      : (a, i) => {
        if (a === null || a === undefined) throw NPE(`Attempted load on null array in ${methodName}`);
        const value = monoArray.load(a, i);
        if (value === monoArray.OOB) throw AIOOBE(i, monoArray.len(a));
        return t === T.ref ? value : toWasmValue(t, value);
      };
    reg.addImport(`aget_${suffix}`, [T.ref, T.i32], [t], load);
    reg.addImport(`aset_${suffix}`, [T.ref, T.i32, t], [], (a, i, v) => {
      if (a === null || a === undefined) throw NPE(`Attempted store on null array in ${methodName}`);
      if (!monoArray.store(a, i, v)) throw AIOOBE(i, monoArray.len(a));
    });
  };
  mk('i', T.i32); mk('l', T.i64); mk('f', T.f32); mk('d', T.f64); mk('r', T.ref);
  reg.addImport('alen', [T.ref], [T.i32], (a) => {
    if (a === null || a === undefined) throw NPE(`Attempted to get length of null array in ${methodName}`);
    return monoArray.len(a);
  });
}

function addFieldImport(reg, jvm, ins, isStaticOp, isGet) {
  const [, className, [fieldName, descriptor]] = ins.arg;
  const t = descToWasm(descriptor[0]);
  if (isStaticOp) {
    // Resolve eagerly at compile time — if the owning class is not loaded
    // and initialized yet, reject rather than risking a skipped <clinit>.
    let currentClassName = className;
    let container = null;
    let key = null;
    while (currentClassName) {
      const cd = jvm.classes[currentClassName];
      if (cd && cd.staticFields) {
        const fieldKey = `${fieldName}:${descriptor}`;
        if (cd.staticFields.has(fieldKey)) { container = cd.staticFields; key = fieldKey; break; }
        if (cd.staticFields.has(fieldName)) { container = cd.staticFields; key = fieldName; break; }
      }
      currentClassName = cd && cd.ast && cd.ast.classes[0] ? cd.ast.classes[0].superClassName : null;
    }
    if (!container) throw new Unsupported(`unresolved static ${className}.${fieldName}`);
    const name = `${isGet ? 'gs' : 'ps'}_${className}_${fieldName}`.replace(/[^\w]/g, '_');
    const getStatic = t === T.i32
      ? () => {
        const value = container.get(key);
        return typeof value === 'boolean' ? (value ? 1 : 0) : value;
      }
      : t === T.ref ? () => container.get(key)
        : () => toWasmValue(t, container.get(key));
    return {
      t,
      name,
      idx: isGet
        ? reg.addImport(name, [], [t], getStatic)
        : reg.addImport(name, [t], [], (v) => container.set(key, v)),
    };
  }
  const name = `${isGet ? 'gf' : 'pf'}_${className}_${fieldName}`.replace(/[^\w]/g, '_');
  const keyCache = new Map();
  // Almost every site is monomorphic; keep the last class's key one identity
  // compare away instead of a Map lookup per access.
  let cachedClassName;
  let cachedFieldKey;
  const resolveKey = (obj) => {
    const ct = obj._className || obj.type;
    if (ct === cachedClassName) return cachedFieldKey;
    let key = keyCache.get(ct);
    if (key === undefined) {
      key = resolveInstanceFieldKey(jvm, obj, className, fieldName) || `${className}.${fieldName}`;
      keyCache.set(ct, key);
    }
    cachedClassName = ct;
    cachedFieldKey = key;
    return key;
  };
  const requireObj = (obj) => {
    if (obj === null || obj === undefined) {
      throw { type: 'java/lang/NullPointerException', message: null };
    }
  };
  const getInstance = t === T.i32
    ? (obj) => {
      requireObj(obj);
      const value = obj.fields[resolveKey(obj)];
      return typeof value === 'boolean' ? (value ? 1 : 0) : value;
    }
    : t === T.ref
      ? (obj) => { requireObj(obj); return obj.fields[resolveKey(obj)]; }
      : (obj) => { requireObj(obj); return toWasmValue(t, obj.fields[resolveKey(obj)]); };
  return {
    t,
    name,
    idx: isGet
      ? reg.addImport(name, [T.ref], [t], getInstance)
      : reg.addImport(name, [T.ref, t], [], (obj, v) => {
        requireObj(obj);
        obj.fields[resolveKey(obj)] = v;
      }),
  };
}

function addMathImport(reg, ins) {
  const [, className, [name, descriptor]] = ins.arg;
  if (className !== 'java/lang/Math' || !MATH_INTRINSICS.has(name)) {
    throw new Unsupported(`invoke ${className}.${name}`);
  }
  const { params, ret } = parseMethodDescriptor(descriptor);
  if (![...params, ret].every((c) => 'IJFD'.includes(c))) {
    throw new Unsupported(`Math.${name}${descriptor} non-numeric`);
  }
  const wParams = params.map(descToWasm);
  const wRet = descToWasm(ret);
  const jsFn = Math[name];
  const fn = ret === 'F'
    ? (...args) => Math.fround(jsFn(...args))
    : (...args) => jsFn(...args);
  return {
    params: wParams,
    ret: wRet,
    idx: reg.addImport(`math_${name}_${descriptor}`.replace(/[^\w]/g, '_'), wParams, [wRet], fn),
  };
}

// Allocation imports (new / newarray / anewarray). None of these run guest
// code or a thread switch, so both backends' field-cache invariants hold:
// array classes have no <clinit>, and `new` compiles only against classes
// whose <clinit> already ran (gated below; INITIALIZED is permanent, so the
// compile-time check stays valid for the module's lifetime). Negative array
// sizes throw the guest NegativeArraySizeException, which unwinds through
// wasm exactly like NPE/AIOOBE from the array imports.
const PRIM_ATYPES = new Set([
  'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double',
]);

function addNewArrayImport(reg, jvm, atype) {
  if (!PRIM_ATYPES.has(atype)) throw new Unsupported(`newarray ${atype}`);
  return reg.addImport(`newarr_${atype}`, [T.i32], [T.ref],
    (count) => allocPrimitiveArray(jvm, atype, count));
}

function addANewArrayImport(reg, jvm, elementType) {
  if (typeof elementType !== 'string') throw new Unsupported('anewarray arg');
  const name = `anewarr_${elementType}`.replace(/[^\w]/g, '_');
  return reg.addImport(name, [T.i32], [T.ref],
    (count) => allocReferenceArray(jvm, elementType, count));
}

function addNewImport(reg, jvm, className) {
  if (typeof className !== 'string') throw new Unsupported('new arg');
  // Same gate as the JS tier's newObjectSync: allocation of a not-yet-
  // initialized class must reach the interpreter so <clinit> can run.
  if (jvm.classInitializationState.get(className) !== 'INITIALIZED' ||
      !jvm.classes[className]) {
    throw new Unsupported(`new ${className} not initialized`);
  }
  // Default field map precomputed once at compile time (the hierarchy above
  // an initialized class is loaded and immutable); each allocation clones it.
  const template = {};
  let currentClassName = className;
  while (currentClassName) {
    const cd = jvm.classes[currentClassName];
    if (!cd || !cd.ast || !cd.ast.classes[0]) break;
    for (const item of cd.ast.classes[0].items) {
      if (item.type !== 'field') continue;
      const d = item.field.descriptor;
      let dv = null;
      if (d === 'I' || d === 'B' || d === 'S' || d === 'Z' || d === 'C') dv = 0;
      else if (d === 'J') dv = BigInt(0);
      else if (d === 'F' || d === 'D') dv = 0.0;
      template[`${currentClassName}.${item.field.name}`] = dv;
    }
    currentClassName = cd.ast.classes[0].superClassName;
  }
  const name = `new_${className}`.replace(/[^\w]/g, '_');
  return reg.addImport(name, [], [T.ref], () => ({
    type: className,
    fields: { ...template },
    hashCode: jvm.nextHashCode++,
    isLocked: false,
    lockOwner: null,
    lockCount: 0,
    waitSet: [],
  }));
}

// System time natives — like Math intrinsics they can never be compiled (JS
// natives), but they are pure reads off the jvm clock (fake-time aware), so
// both backends import them directly instead of demoting the call block.
function addTimeImport(reg, jvm, ins) {
  const [, className, [name, descriptor]] = ins.arg;
  if (className !== 'java/lang/System' || descriptor !== '()J' ||
      (name !== 'currentTimeMillis' && name !== 'nanoTime')) {
    throw new Unsupported(`invoke ${className}.${name}`);
  }
  const fn = name === 'nanoTime'
    ? () => BigInt(jvm.clock.nanos())
    : () => BigInt(jvm.clock.millis());
  return { params: [], partial: false, idx: reg.addImport(`sys_${name}`, [], [T.i64], fn) };
}

module.exports = {
  addRuntimeImports,
  pushImportFor,
  addArrayImports,
  addFieldImport,
  addMathImport,
  addTimeImport,
  addNewArrayImport,
  addANewArrayImport,
  addNewImport,
};
