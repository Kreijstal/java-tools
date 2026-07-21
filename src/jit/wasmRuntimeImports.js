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

const { resolveInstanceFieldKey } = require('../instructions/object');
const {
  T, NPE, AIOOBE, MATH_INTRINSICS, Unsupported,
  descToWasm, toWasmValue, parseMethodDescriptor,
} = require('./wasmShared');

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
  const elemsOf = (a, i, opName) => {
    // bug-compatible with instructions/utils.js: bounds use arrayRef.length
    if (a === null || a === undefined) throw NPE(`Attempted ${opName} on null array in ${methodName}`);
    if (i < 0 || i >= a.length) throw AIOOBE(i, a.length);
    return a;
  };
  const mk = (suffix, t) => {
    const load = t === T.i32
      ? (a, i) => {
        const arr = elemsOf(a, i, 'load');
        const value = arr.elements ? arr.elements[i] : arr[i];
        return typeof value === 'boolean' ? (value ? 1 : 0) : value;
      }
      : t === T.ref
        ? (a, i) => {
          const arr = elemsOf(a, i, 'load');
          return arr.elements ? arr.elements[i] : arr[i];
        }
        : (a, i) => {
          const arr = elemsOf(a, i, 'load');
          return toWasmValue(t, arr.elements ? arr.elements[i] : arr[i]);
        };
    reg.addImport(`aget_${suffix}`, [T.ref, T.i32], [t], load);
    reg.addImport(`aset_${suffix}`, [T.ref, T.i32, t], [], (a, i, v) => {
      elemsOf(a, i, 'store')[i] = v;
    });
  };
  mk('i', T.i32); mk('l', T.i64); mk('f', T.f32); mk('d', T.f64); mk('r', T.ref);
  reg.addImport('alen', [T.ref], [T.i32], (a) => {
    if (a === null || a === undefined) throw NPE(`Attempted to get length of null array in ${methodName}`);
    return a.length;
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
};
