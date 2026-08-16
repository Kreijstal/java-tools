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
  mathIntrinsicFunction,
  descToWasm, toWasmValue, parseMethodDescriptor,
} = require('./wasmShared');
const monoArray = require('./monoArray');
const {
  instanceFieldTemplate, makeObjectRef, slabLayoutFor, makeSlabFields,
} = require('../core/objectModel');
const {
  normalizeArrayLoad,
  normalizeArrayStore,
} = require('../instructions/utils');

/*
 * Debug: record every array access made by a matching method, so the SAME
 * method compiled by the two backends can be diffed access-for-access. Both
 * backends route array access through these imports, so the trace is directly
 * comparable and the first differing line names the operation that diverges --
 * which per-block bisection cannot do cheaply, because heavily demoted modules
 * exit on nearly every entry and never finish.
 *
 * JVM_WASM_TRACE_ARRAYS=<method substring>, JVM_WASM_TRACE_ARRAYS_OUT=<file>.
 */
const ARRAY_TRACE_PATTERN = process.env.JVM_WASM_TRACE_ARRAYS || '';
// A full verbatim trace does not fit: kr.e crashes millions of accesses in.
// Instead hash every access into fixed-size chunks, so two runs can be
// compared chunk-for-chunk to find the first differing window in constant
// memory, and keep only the last TAIL accesses verbatim for the crash site.
const ARRAY_TRACE_CHUNK = Number(process.env.JVM_WASM_TRACE_ARRAYS_CHUNK || 50000);
const ARRAY_TRACE_TAIL = Number(process.env.JVM_WASM_TRACE_ARRAYS_TAIL || 400);
// Verbatim capture of one access window, for zooming in on the differing
// chunk that the hashes identify.
const ARRAY_TRACE_FROM = Number(process.env.JVM_WASM_TRACE_ARRAYS_FROM || 0);
const ARRAY_TRACE_TO = Number(process.env.JVM_WASM_TRACE_ARRAYS_TO || 0);
const arrayTraceWindow = [];
const arrayTraceChunks = [];
const arrayTraceTail = [];
let arrayTraceCount = 0;
let arrayTraceHash = 0x811c9dc5;
let arrayTraceInstalled = false;

function arrayTracer(methodName) {
  if (!ARRAY_TRACE_PATTERN || !String(methodName).includes(ARRAY_TRACE_PATTERN)) {
    return null;
  }
  if (!arrayTraceInstalled && typeof process !== 'undefined' && process.on) {
    arrayTraceInstalled = true;
    process.on('exit', () => {
      const out = process.env.JVM_WASM_TRACE_ARRAYS_OUT;
      if (!out) return;
      try {
        const lines = [`# accesses=${arrayTraceCount} chunk=${ARRAY_TRACE_CHUNK}`];
        arrayTraceChunks.forEach((h, n) => lines.push(`CHUNK ${n} ${h >>> 0}`));
        if (arrayTraceWindow.length) {
          lines.push('# window');
          for (const w of arrayTraceWindow) lines.push(w);
        }
        lines.push('# tail');
        for (const t of arrayTraceTail) lines.push(t);
        require('fs').writeFileSync(out, lines.join('\n'));
        console.error(`[wasm-array-trace] ${arrayTraceCount} accesses, ` +
          `${arrayTraceChunks.length} chunks -> ${out}`);
      } catch (err) {
        console.error(`[wasm-array-trace] write failed: ${err.message}`);
      }
    });
  }
  return (op, a, i) => {
    const len = a === null || a === undefined ? -1 : monoArray.len(a);
    // FNV-1a over the access triple; order-sensitive, so any divergence in
    // sequence, index, or array size changes the chunk hash.
    let h = arrayTraceHash;
    const s = `${op}|${len}|${i};`;
    for (let k = 0; k < s.length; k += 1) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    arrayTraceHash = h;
    arrayTraceCount += 1;
    if (arrayTraceCount % ARRAY_TRACE_CHUNK === 0) {
      arrayTraceChunks.push(arrayTraceHash);
      arrayTraceHash = 0x811c9dc5;
    }
    if (ARRAY_TRACE_TO && arrayTraceCount >= ARRAY_TRACE_FROM
        && arrayTraceCount < ARRAY_TRACE_TO) {
      arrayTraceWindow.push(`${arrayTraceCount} ${op} len=${len} idx=${i}`);
    }
    arrayTraceTail.push(`${arrayTraceCount} ${op} len=${len} idx=${i}`);
    if (arrayTraceTail.length > ARRAY_TRACE_TAIL) arrayTraceTail.shift();
  };
}

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

function addTypedArrayStoreImports(reg, methodName, traceKey = methodName) {
  const trace = arrayTracer(traceKey);
  const checkedStore = (op, t, narrow) => {
    reg.addImport(`aset_${op}`, [T.ref, T.i32, t], [], (a, i, v) => {
      if (trace) trace(op, a, i);
      if (a === null || a === undefined) {
        throw NPE(`Attempted store on null array in ${methodName}`);
      }
      const stored = narrow ? narrow(a, v) : v;
      if (!monoArray.store(a, i, stored)) {
        throw AIOOBE(i, monoArray.len(a));
      }
    });
  };
  // Wasm import signatures already coerce i32/i64/f32/f64 values to the
  // exact primitive width. Only the three i32-backed narrow array kinds need
  // additional work when the JVM array uses a plain JavaScript Array.
  checkedStore('iastore', T.i32, null);
  checkedStore('lastore', T.i64, null);
  checkedStore('fastore', T.f32, null);
  checkedStore('dastore', T.f64, null);
  checkedStore('aastore', T.ref, null);
  checkedStore('bastore', T.i32, (a, v) =>
    a.type === '[Z' || a.elementType === 'boolean'
      ? v & 1 : (v << 24) >> 24);
  checkedStore('castore', T.i32, (_a, v) => v & 0xffff);
  checkedStore('sastore', T.i32, (_a, v) => (v << 16) >> 16);
}

function addArrayImports(reg, methodName, typedArrayStores = true, traceKey = methodName) {
  const trace = arrayTracer(traceKey);
  const mk = (suffix, t) => {
    // monoArray keeps each backing class (plain Array vs wasm-heap TypedArray
    // views) on its own monomorphic keyed IC — one shared `a[i]` site over
    // that mix goes megamorphic and dominates the profile.
    const load = t === T.i32
      ? (a, i) => {
        if (trace) trace(`aget_${suffix}`, a, i);
        if (a === null || a === undefined) throw NPE(`Attempted load on null array in ${methodName}`);
        const value = monoArray.load(a, i);
        if (value === monoArray.OOB) throw AIOOBE(i, monoArray.len(a));
        return normalizeArrayLoad(value, null, a);
      }
      : (a, i) => {
        if (trace) trace(`aget_${suffix}`, a, i);
        // Reference arrays are always plain JS Arrays, and this import sits in
        // the inner loop of every polymorphic call site (the receiver load).
        // Inlining that one case keeps it a single monomorphic keyed load
        // instead of a call into the array zoo plus a sentinel comparison.
        if (t === T.ref && Array.isArray(a)) {
          const u = i >>> 0;
          if (u < a.length) return a[u];
          throw AIOOBE(i, a.length);
        }
        if (a === null || a === undefined) throw NPE(`Attempted load on null array in ${methodName}`);
        const value = monoArray.load(a, i);
        if (value === monoArray.OOB) throw AIOOBE(i, monoArray.len(a));
        return t === T.ref ? value : toWasmValue(t, value);
    };
    reg.addImport(`aget_${suffix}`, [T.ref, T.i32], [t], load);
    if (!typedArrayStores) {
      reg.addImport(`aset_${suffix}`, [T.ref, T.i32, t], [], (a, i, v) => {
        if (trace) trace(`aset_${suffix}`, a, i);
        if (a === null || a === undefined) {
          throw NPE(`Attempted store on null array in ${methodName}`);
        }
        if (!monoArray.store(a, i, normalizeArrayStore(v, null, a))) {
          throw AIOOBE(i, monoArray.len(a));
        }
      });
    }
  };
  mk('i', T.i32); mk('l', T.i64); mk('f', T.f32); mk('d', T.f64); mk('r', T.ref);
  if (typedArrayStores) addTypedArrayStoreImports(reg, methodName, traceKey);
  reg.addImport('alen', [T.ref], [T.i32], (a) => {
    if (a === null || a === undefined) throw NPE(`Attempted to get length of null array in ${methodName}`);
    return monoArray.len(a);
  });
}

// `elementOf` turns an instance field access into one that takes (array,
// index) and loads the receiver itself. The caller uses it when the receiver's
// only consumers are accesses like this one, so the element load never needs a
// boundary crossing of its own. Everything downstream is unchanged.
function addFieldImport(reg, jvm, ins, isStaticOp, isGet, elementOf = null) {
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
  const name = `${isGet ? 'gf' : 'pf'}${elementOf ? 'at' : ''}_${className}_${fieldName}`
    .replace(/[^\w]/g, '_');
  const keyCache = new Map();
  // Storage key per receiver class, indexed by the object's dense class index
  // (see classIndexOf): an array read, no string leaves the guest object on
  // the hot path. A one-entry cache was enough while sites were assumed
  // monomorphic, but a three-receiver site missed it on two calls in three and
  // fell back to hashing the class name. Objects without an index — host-made
  // refs, arrays — read through keyOf every time, as they always did.
  const keyByIndex = [];
  const keyOf = (obj) => {
    const ct = obj._className || obj.type;
    let key = keyCache.get(ct);
    if (key === undefined) {
      key = resolveInstanceFieldKey(jvm, obj, className, fieldName) || `${className}.${fieldName}`;
      keyCache.set(ct, key);
    }
    return key;
  };
  const resolveKey = (obj) => {
    const index = obj.cidx;
    if (index === undefined) return keyOf(obj);
    const hit = keyByIndex[index];
    if (hit !== undefined) return hit;
    const key = keyOf(obj);
    keyByIndex[index] = key;
    return key;
  };
  const requireObj = (obj) => {
    if (obj === null || obj === undefined) {
      throw { type: 'java/lang/NullPointerException', message: null };
    }
  };
  const readInstance = (obj) => {
    const key = resolveKey(obj);
    if (obj.fields) return obj.fields[key];
    return obj[key] ?? obj[fieldName];
  };
  const writeInstance = (obj, value) => {
    const key = resolveKey(obj);
    if (obj.fields) {
      obj.fields[key] = value;
    } else if (Object.prototype.hasOwnProperty.call(obj, key)) {
      obj[key] = value;
    } else {
      obj[fieldName] = value;
    }
  };
  const getInstance = t === T.i32
    ? (obj) => {
      // Flattened on purpose: this is the single hottest import in a
      // polymorphic call site, and the null check, key lookup and field read
      // are three call frames otherwise.
      if (obj === null || obj === undefined) {
        throw { type: 'java/lang/NullPointerException', message: null };
      }
      const fields = obj.fields;
      if (fields === undefined) {
        const value = readInstance(obj);
        return typeof value === 'boolean' ? (value ? 1 : 0) : value;
      }
      const value = fields[keyByIndex[obj.cidx] ?? resolveKey(obj)];
      return typeof value === 'boolean' ? (value ? 1 : 0) : value;
    }
    : t === T.ref
      ? (obj) => { requireObj(obj); return readInstance(obj); }
      : (obj) => { requireObj(obj); return toWasmValue(t, readInstance(obj)); };
  if (elementOf) {
    // int fields get their own flattened body rather than composing the two
    // helpers: this import is called once per iteration of a polymorphic hot
    // loop, and each closure frame it does not enter is worth about a
    // nanosecond of the ~3 it costs.
    const getFromArray = t !== T.i32 ? (array, i) => getInstance(elementOf(array, i))
      : (array, i) => {
        const u = i >>> 0;
        const obj = Array.isArray(array) && u < array.length
          ? array[u] : elementOf(array, i);
        if (obj === null || obj === undefined) {
          throw { type: 'java/lang/NullPointerException', message: null };
        }
        const fields = obj.fields;
        if (fields === undefined) {
          const value = readInstance(obj);
          return typeof value === 'boolean' ? (value ? 1 : 0) : value;
        }
        const value = fields[keyByIndex[obj.cidx] ?? resolveKey(obj)];
        return typeof value === 'boolean' ? (value ? 1 : 0) : value;
      };
    return {
      t,
      name,
      idx: isGet
        ? reg.addImport(name, [T.ref, T.i32], [t], getFromArray)
        : reg.addImport(name, [T.ref, T.i32, t], [], (array, i, v) => {
          const obj = elementOf(array, i);
          requireObj(obj);
          writeInstance(obj, v);
        }),
    };
  }
  return {
    t,
    name,
    idx: isGet
      ? reg.addImport(name, [T.ref], [t], getInstance)
      : reg.addImport(name, [T.ref, t], [], (obj, v) => {
        requireObj(obj);
        writeInstance(obj, v);
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
  const fn = mathIntrinsicFunction(name, descriptor);
  if (!fn) throw new Unsupported(`Math.${name}${descriptor} unsupported`);
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
  const layout = slabLayoutFor(jvm, className);
  const template = layout ? null : instanceFieldTemplate(jvm, className);
  const name = `new_${className}`.replace(/[^\w]/g, '_');
  return reg.addImport(name, [], [T.ref], () => makeObjectRef(jvm, className,
    layout
      ? (makeSlabFields(jvm, layout) || instanceFieldTemplate(jvm, className))
      : { ...template }));
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
  arrayTracer,
  addRuntimeImports,
  pushImportFor,
  addArrayImports,
  addTypedArrayStoreImports,
  addFieldImport,
  addMathImport,
  addTimeImport,
  addNewArrayImport,
  addANewArrayImport,
  addNewImport,
};
