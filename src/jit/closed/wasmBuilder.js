'use strict';

// Minimal Wasm (GC + legacy EH) binary builder for the closed-world backend.
//
// Code is written as flat arrays of bytes interleaved with symbolic markers
// ({fn:key}, {global:key}, {type:key}); build() resolves every marker once all
// imports, functions and globals are known. That lets a compiler emit bodies
// in any order and request imports while it emits, with no index renumbering.

const VT = {
  i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c,
  anyref: 0x6e, externref: 0x6f, funcref: 0x70, eqref: 0x6d,
};
const HT = { any: 0x6e, eq: 0x6d, i31: 0x6c, struct: 0x6b, array: 0x6a, extern: 0x6f, func: 0x70, none: 0x71 };

function uleb(value) {
  const out = [];
  let v = value >>> 0;
  if (value > 0xffffffff || value < 0) throw new Error(`uleb out of range: ${value}`);
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function sleb(value) {
  const out = [];
  if (typeof value === 'bigint') {
    let v = value;
    for (;;) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      if ((v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0)) {
        out.push(byte);
        return out;
      }
      out.push(byte | 0x80);
    }
  }
  let v = value | 0;
  if (v !== value) throw new Error(`sleb32 out of range: ${value}`);
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

const f32Buffer = new DataView(new ArrayBuffer(8));
function f32bytes(value) {
  f32Buffer.setFloat32(0, value, true);
  return [0, 1, 2, 3].map((i) => f32Buffer.getUint8(i));
}
function f64bytes(value) {
  f32Buffer.setFloat64(0, value, true);
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => f32Buffer.getUint8(i));
}
function name(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  return [...uleb(bytes.length), ...bytes];
}
function vec(items) {
  return [...uleb(items.length), ...items.flat()];
}
function section(id, bytes) {
  return bytes.length ? [id, ...uleb(bytes.length), ...bytes] : [];
}

// Value-type encodings for typed references: (ref null $t) / (ref $t).
// A type operand may be a symbolic marker resolved at build time.
// Abstract heap types are named ('any', 'extern', ...); anything else is a
// concrete type index or a rec-group key ('closed:1').
const heapType = (type) => (typeof type === 'string' && HT[type] !== undefined ? HT[type] : { stype: type });
const refNull = (type) => [0x63, heapType(type)];
const ref = (type) => [0x64, heapType(type)];

// Opcodes (subset used by the closed backend).
const OP = {
  unreachable: 0x00, nop: 0x01, block: 0x02, loop: 0x03, if: 0x04, else: 0x05,
  try: 0x06, catch: 0x07, throw: 0x08, rethrow: 0x09, end: 0x0b, br: 0x0c, br_if: 0x0d,
  br_table: 0x0e, return: 0x0f, call: 0x10, call_indirect: 0x11, catch_all: 0x19,
  drop: 0x1a, select: 0x1b,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22, global_get: 0x23, global_set: 0x24,
  i32_load: 0x28, i64_load: 0x29, f32_load: 0x2a, f64_load: 0x2b,
  i32_load8_s: 0x2c, i32_load8_u: 0x2d, i32_load16_s: 0x2e, i32_load16_u: 0x2f,
  i32_store: 0x36, i64_store: 0x37, f32_store: 0x38, f64_store: 0x39,
  i32_store8: 0x3a, i32_store16: 0x3b,
  i32_const: 0x41, i64_const: 0x42, f32_const: 0x43, f64_const: 0x44,
  i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49,
  i32_gt_s: 0x4a, i32_gt_u: 0x4b, i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
  i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_gt_s: 0x55,
  f32_eq: 0x5b, f32_ne: 0x5c, f32_lt: 0x5d, f32_gt: 0x5e,
  f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_rem_s: 0x6f,
  i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
  i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_rem_s: 0x81,
  i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
  f32_neg: 0x8c, f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94, f32_div: 0x95,
  f64_neg: 0x9a, f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3,
  i32_wrap_i64: 0xa7, i64_extend_i32_s: 0xac,
  f32_convert_i32_s: 0xb2, f32_convert_i64_s: 0xb4, f32_demote_f64: 0xb6,
  f64_convert_i32_s: 0xb7, f64_convert_i64_s: 0xb9, f64_promote_f32: 0xbb,
  i32_extend8_s: 0xc0, i32_extend16_s: 0xc1,
  ref_null: 0xd0, ref_is_null: 0xd1, ref_func: 0xd2, ref_eq: 0xd3, ref_as_non_null: 0xd4,
  br_on_null: 0xd5, br_on_non_null: 0xd6,
};
// 0xfb-prefixed GC ops and 0xfc-prefixed saturating truncations.
const GC = {
  struct_new: [0xfb, 0x00], struct_get: [0xfb, 0x02], struct_set: [0xfb, 0x05],
  array_new: [0xfb, 0x06], array_new_default: [0xfb, 0x07], array_get: [0xfb, 0x0b],
  array_set: [0xfb, 0x0e], array_len: [0xfb, 0x0f], array_fill: [0xfb, 0x10], array_copy: [0xfb, 0x11],
  ref_test: [0xfb, 0x14], ref_test_null: [0xfb, 0x15], ref_cast: [0xfb, 0x16], ref_cast_null: [0xfb, 0x17],
  br_on_cast: [0xfb, 0x18], br_on_cast_fail: [0xfb, 0x19],
  any_convert_extern: [0xfb, 0x1a], extern_convert_any: [0xfb, 0x1b],
};
const SAT = {
  i32_trunc_sat_f32_s: [0xfc, 0], i32_trunc_sat_f64_s: [0xfc, 2],
  i64_trunc_sat_f32_s: [0xfc, 4], i64_trunc_sat_f64_s: [0xfc, 6],
};

// Composite type encodings.
const storage = (type, mutable) => [...(Array.isArray(type) ? type : [type]), mutable ? 1 : 0];
const structType = (fields) => [0x5f, ...vec(fields.map((f) => storage(f.type, f.mutable)))];
const arrayType = (type, mutable) => [0x5e, ...storage(type, mutable)];
const funcType = (params, results) => [0x60,
  ...uleb(params.length), ...params.flat(), ...uleb(results.length), ...results.flat()];

class ModuleBuilder {
  constructor() {
    this.recGroups = [];     // [{key, entries:[bytes]}] occupying the first type indices
    this.types = [];         // flat list of type entries after rec groups (function types)
    this.typeKeys = new Map();
    this.imports = [];       // {module, name, kind, desc, key}
    this.importFuncCount = 0;
    this.importGlobalCount = 0;
    this.functions = [];     // {key, type, locals:[valtype bytes], code:[...]}
    this.functionByKey = new Map();
    this.globals = [];       // {key, type, mutable, init:[bytes]}
    this.exports = [];
    this.declaredFuncs = new Set();
    this.nextTypeIndex = 0;
  }

  // A rec group occupies consecutive type indices starting at the current
  // count. Groups must be added before any function type.
  addRecGroup(key, entries) {
    if (this.types.length) throw new Error('rec groups must precede function types');
    const base = this.nextTypeIndex;
    this.recGroups.push({ key, entries });
    this.nextTypeIndex += entries.length;
    return base;
  }

  funcType(params, results) {
    const bytes = funcType(params, results);
    const signature = JSON.stringify(bytes);
    let index = this.typeKeys.get(signature);
    if (index === undefined) {
      index = this.nextTypeIndex++;
      this.types.push(bytes);
      this.typeKeys.set(signature, index);
    }
    return index;
  }

  importFunction(module, field, params, results, key = `${module}.${field}`) {
    if (this.functionByKey.has(key)) return key;
    if (this.functions.length) throw new Error('imports must precede defined functions');
    const type = this.funcType(params, results);
    this.imports.push({ module, name: field, kind: 0, desc: uleb(type), key });
    this.functionByKey.set(key, this.importFuncCount++);
    return key;
  }

  importGlobal(module, field, valtype, mutable, key = `${module}.${field}`) {
    if (this.globalIndex(key) !== undefined) return key;
    this.imports.push({ module, name: field, kind: 3, desc: [...valtype, mutable ? 1 : 0], key, global: true });
    (this.globalKeys ||= new Map()).set(key, this.importGlobalCount++);
    return key;
  }

  importMemory(module, field, minimumPages, maximumPages) {
    const limits = maximumPages === undefined ? [0, ...uleb(minimumPages)]
      : [1, ...uleb(minimumPages), ...uleb(maximumPages)];
    this.imports.push({ module, name: field, kind: 2, desc: limits, key: `${module}.${field}` });
  }

  importTag(module, field, params, key) {
    const type = this.funcType(params, []);
    this.imports.push({ module, name: field, kind: 4, desc: [0, ...uleb(type)], key, tag: true });
    (this.tagKeys ||= new Map()).set(key, (this.tagCount = (this.tagCount || 0)) );
    this.tagCount += 1;
    return key;
  }

  globalIndex(key) { return this.globalKeys?.get(key); }

  // Reserve a defined function; its body can be supplied later.
  declareFunction(key, params, results) {
    if (this.functionByKey.has(key)) throw new Error(`duplicate function ${key}`);
    const type = this.funcType(params, results);
    const entry = { key, type, params, results, locals: [], code: null };
    this.functions.push(entry);
    return entry;
  }

  defineFunction(key, locals, code) {
    const entry = this.functions.find((f) => f.key === key);
    if (!entry) throw new Error(`undeclared function ${key}`);
    entry.locals = locals;
    entry.code = code;
  }

  addGlobal(key, valtype, mutable, init) {
    this.globals.push({ key, valtype, mutable, init });
  }

  exportFunction(field, key) { this.exports.push({ name: field, kind: 0, key }); }
  exportGlobal(field, key) { this.exports.push({ name: field, kind: 3, key, global: true }); }
  declareRefFunc(key) { this.declaredFuncs.add(key); }

  build() {
    const funcIndex = new Map(this.functionByKey);
    this.functions.forEach((f, i) => funcIndex.set(f.key, this.importFuncCount + i));
    const globalIndex = new Map(this.globalKeys || []);
    this.globals.forEach((g, i) => globalIndex.set(g.key, this.importGlobalCount + i));
    const recTypeIndex = new Map();
    let at = 0;
    for (const group of this.recGroups) {
      group.entries.forEach((_, i) => recTypeIndex.set(`${group.key}:${i}`, at + i));
      at += group.entries.length;
    }
    const resolve = (code, where) => {
      const out = [];
      for (const item of code) {
        if (typeof item === 'number') { out.push(item); continue; }
        if (item === undefined || item === null) throw new Error(`undefined code byte in ${where}`);
        if (item.fn !== undefined) {
          const index = funcIndex.get(item.fn);
          if (index === undefined) throw new Error(`unresolved function ${item.fn} in ${where}`);
          out.push(...uleb(index));
        } else if (item.global !== undefined) {
          const index = globalIndex.get(item.global);
          if (index === undefined) throw new Error(`unresolved global ${item.global} in ${where}`);
          out.push(...uleb(index));
        } else if (item.type !== undefined) {
          const index = typeof item.type === 'number' ? item.type : recTypeIndex.get(item.type);
          if (index === undefined) throw new Error(`unresolved type ${item.type} in ${where}`);
          out.push(...uleb(index));
        } else if (item.stype !== undefined) {
          const index = typeof item.stype === 'number' ? item.stype : recTypeIndex.get(item.stype);
          if (index === undefined) throw new Error(`unresolved type ${item.stype} in ${where}`);
          out.push(...sleb(index));
        } else if (item.tag !== undefined) {
          const index = this.tagKeys?.get(item.tag);
          if (index === undefined) throw new Error(`unresolved tag ${item.tag} in ${where}`);
          out.push(...uleb(index));
        } else {
          throw new Error(`unknown code marker ${JSON.stringify(item)} in ${where}`);
        }
      }
      return out;
    };

    const typeEntries = [];
    for (const group of this.recGroups) {
      const entries = group.entries.map((e) => resolve(e, `rec ${group.key}`));
      typeEntries.push([0x4e, ...uleb(entries.length), ...entries.flat()]);
    }
    for (const t of this.types) typeEntries.push(resolve(t, 'type'));

    const importEntries = this.imports.map((imp) => [...name(imp.module), ...name(imp.name), imp.kind,
      ...resolve(imp.desc, `import ${imp.key}`)]);
    const functionEntries = this.functions.map((f) => uleb(f.type));
    const globalEntries = this.globals.map((g) => [...resolve(g.valtype, `global ${g.key}`), g.mutable ? 1 : 0,
      ...resolve(g.init, `global ${g.key}`), OP.end]);
    const exportEntries = this.exports.map((e) => {
      const index = e.global ? globalIndex.get(e.key) : funcIndex.get(e.key);
      if (index === undefined) throw new Error(`unresolved export ${e.key}`);
      return [...name(e.name), e.kind, ...uleb(index)];
    });
    const declared = [...this.declaredFuncs].map((key) => {
      const index = funcIndex.get(key);
      if (index === undefined) throw new Error(`unresolved ref.func ${key}`);
      return uleb(index);
    });
    // Declarative element segment (flags 3): makes ref.func legal for these.
    const elementEntries = declared.length ? [[3, 0, ...vec(declared)]] : [];
    const codeEntries = this.functions.map((f) => {
      if (!f.code) throw new Error(`function ${f.key} has no body`);
      // Run-length encode identical consecutive local types.
      const groups = [];
      for (const local of f.locals) {
        const encoded = JSON.stringify(local);
        const last = groups[groups.length - 1];
        if (last && last.encoded === encoded) last.count += 1;
        else groups.push({ encoded, local, count: 1 });
      }
      const localBytes = [...uleb(groups.length),
        ...groups.flatMap((g) => [...uleb(g.count), ...resolve(Array.isArray(g.local) ? g.local : [g.local], f.key)])];
      const body = [...localBytes, ...resolve(f.code, f.key), OP.end];
      return [...uleb(body.length), ...body];
    });

    const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...section(1, vec(typeEntries)),
      ...section(2, vec(importEntries)),
      ...section(3, vec(functionEntries)),
      ...section(6, vec(globalEntries)),
      ...section(7, vec(exportEntries)),
      ...section(9, vec(elementEntries)),
      ...section(10, vec(codeEntries)),
    ];
    return Uint8Array.from(bytes);
  }
}

module.exports = {
  VT, HT, OP, GC, SAT, uleb, sleb, f32bytes, f64bytes, refNull, ref, heapType,
  structType, arrayType, funcType, ModuleBuilder,
};
