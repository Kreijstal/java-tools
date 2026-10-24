'use strict';

// Closed-world Wasm: every admitted guest method compiled into ONE module over
// the VM-owned closed representation (representation.js), with direct calls
// between admitted methods and in-module virtual dispatch on class ids.
//
// Admission is closed: a method is admitted only when each operation it can
// perform is either native to the module or one synchronous host import, and
// every guest method it can call is itself admitted (greatest fixed point).
// There is therefore no deoptimization and no frame reconstruction: an
// admitted invocation always runs to completion (or throws) inside Wasm.
//
// Not admitted in this version: exception handlers, monitors (synchronized
// methods, monitorenter/exit), jsr/ret, invokedynamic, irreducible control
// flow, field access on classes without a closed layout. Those methods keep
// running on the existing tiers, which call into the module through the entry
// adapters.
//
// Class initialization: an entry is used only once every class its admitted
// closure may initialize (static access, new, invokestatic owners) is already
// INITIALIZED, so nothing inside the module ever triggers <clinit>.

const { buildSsa } = require('../../analysis/opgraph/ssa');
const { VT, ModuleBuilder } = require('./wasmBuilder');
const { closedTypes } = require('./representation');
const { ClosedCompiler, Unsupported, WT } = require('./ClosedCompiler');

const REJECT_OPS = new Set(['monitorenter', 'monitorexit', 'jsr', 'jsr_w', 'ret', 'invokedynamic']);
const NEWARRAY = { 4: 'boolean', 5: 'char', 6: 'float', 7: 'double', 8: 'byte', 9: 'short', 10: 'int', 11: 'long' };

class ClosedWorldError extends Error {}

function kindOf(descriptor) {
  switch (descriptor[0]) {
    case 'Z': case 'B': case 'C': case 'S': case 'I': return 'I';
    case 'J': return 'J';
    case 'F': return 'F';
    case 'D': return 'D';
    case 'V': return 'V';
    default: return 'A';
  }
}

function parseMethodDescriptor(descriptor) {
  const params = [];
  let i = 1;
  while (descriptor[i] !== ')') {
    const start = i;
    while (descriptor[i] === '[') i++;
    if (descriptor[i] === 'L') i = descriptor.indexOf(';', i);
    i++;
    params.push(descriptor.slice(start, i));
  }
  return { params, ret: descriptor.slice(i + 1) };
}

const flagsOf = (method) => method.flags || [];
const isStaticMethod = (method) => flagsOf(method).includes('static');

class ClosedWorld {
  constructor(jit) {
    this.jit = jit;
    this.jvm = jit.jvm;
    this.runtime = this.jvm.closedRuntime;
    this.entries = new Map();      // key -> admitted record
    this.entryByMethod = new Map(); // method object -> record
    this.rejected = new Map();     // key -> reason
    this.imports = new Map();      // import key -> {params, results, impl}
    this.globalImports = new Map(); // global key -> {valtype, mutable, value}
    this.sites = [];               // diagnostics for vmiss / cce
    this.built = false;
    this.counters = { entries: 0, entryFallbacks: 0, notReady: 0 };
    this.thread = null;
    if (typeof process !== 'undefined' && process.env?.JVM_CLOSED_WORLD_STATS) {
      process.once('exit', () => {
        const rejected = [...this.rejected].map(([key, reason]) => `${key}\t${reason}`).join('\n');
        process.stderr.write(`[closed-world] ${JSON.stringify(this.stats())}\n`);
        if (process.env.JVM_CLOSED_WORLD_STATS === 'rejects') process.stderr.write(`${rejected}\n`);
        if (this.importCalls) {
          const top = [...this.importCalls].filter(([, n]) => n).sort((x, y) => y[1] - x[1]).slice(0, 40);
          process.stderr.write(top.map(([key, n]) => `[closed-import] ${n}\t${key}`).join('\n') + '\n');
        }
      });
    }
  }

  stats() {
    return {
      built: this.built,
      admitted: this.entries.size,
      rejected: this.rejected.size,
      rejectReasons: [...this.rejected.values()].reduce((m, r) => { const k = r.split(':')[0]; m[k] = (m[k] || 0) + 1; return m; }, {}),
      imports: this.imports.size,
      moduleBytes: this.moduleBytes || 0,
      ...this.counters,
    };
  }

  // ---- class model helpers ----------------------------------------------
  classAst(name) { return this.jvm.classes[name]?.ast?.classes?.[0] || null; }
  isGuestClass(name) {
    const data = this.jvm.classes[name];
    return !!(data && data.ast && !data.isJreStub && !(this.jvm.jre && this.jvm.jre[name]));
  }
  isInterface(name) {
    const ast = this.classAst(name);
    return !!ast && (ast.flags || []).includes('interface');
  }
  isAbstract(name) {
    const ast = this.classAst(name);
    return !!ast && ((ast.flags || []).includes('abstract') || (ast.flags || []).includes('interface'));
  }
  classId(name) { return require('../../core/objectModel').classIndexOf(this.jvm, name); }

  findDeclaredMethod(className, name, descriptor) {
    const ast = this.classAst(className);
    if (!ast) return null;
    for (const item of ast.items) {
      if (item.type === 'method' && item.method.name === name && item.method.descriptor === descriptor) return item.method;
    }
    return null;
  }

  // Resolve like invokevirtual: walk superclasses; a JRE class in the chain
  // answers with its native shim; finally default interface methods.
  resolveVirtual(className, name, descriptor) {
    const jvm = this.jvm;
    let current = className;
    const interfaces = [];
    while (current) {
      if (jvm.jre && jvm.jre[current]) {
        const native = jvm._jreFindMethod(current, name, descriptor);
        if (native) return { native, owner: current };
      }
      const ast = this.classAst(current);
      if (!ast) break;
      const method = this.findDeclaredMethod(current, name, descriptor);
      if (method && !flagsOf(method).includes('abstract') && !isStaticMethod(method)) return { method, owner: current };
      interfaces.push(...(ast.interfaces || []));
      current = ast.superClassName || null;
    }
    const seen = new Set();
    while (interfaces.length) {
      const iface = interfaces.shift();
      if (seen.has(iface)) continue;
      seen.add(iface);
      const method = this.findDeclaredMethod(iface, name, descriptor);
      if (method && !flagsOf(method).includes('abstract') && !isStaticMethod(method) &&
          method.attributes?.some((a) => a.type === 'code')) return { method, owner: iface };
      interfaces.push(...(this.classAst(iface)?.interfaces || []));
    }
    return null;
  }

  // invokestatic / invokespecial resolution from a starting class.
  resolveFrom(className, name, descriptor, wantStatic) {
    const jvm = this.jvm;
    let current = className;
    while (current) {
      const native = jvm.jre && jvm.jre[current] ? jvm._jreFindMethod(current, name, descriptor) : null;
      if (native) return { native, owner: current };
      const ast = this.classAst(current);
      if (!ast) return null;
      const method = this.findDeclaredMethod(current, name, descriptor);
      if (method) return isStaticMethod(method) === wantStatic ? { method, owner: current } : null;
      if (name === '<init>') return null;
      current = ast.superClassName || null;
    }
    return null;
  }

  // Declaring class of a static field reachable from `owner`.
  staticFieldOwner(owner, name, descriptor) {
    const jvm = this.jvm;
    const queue = [owner];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      const ast = this.classAst(current);
      if (ast?.items.some((item) => item.type === 'field' && item.field.name === name &&
          (item.field.flags || []).includes('static'))) return current;
      const jreStatics = jvm.jre?.[current]?.staticFields;
      if (jreStatics && (jreStatics instanceof Map ? jreStatics.has(`${name}:${descriptor}`)
        : Object.hasOwn(jreStatics, `${name}:${descriptor}`))) return current;
      if (ast) queue.push(ast.superClassName, ...(ast.interfaces || []));
      else if (jvm.jre?.[current]?.super) queue.push(jvm.jre[current].super);
    }
    return null;
  }

  staticStore(className) {
    return this.jvm.classes[className]?.staticFields || this.jvm.jre?.[className]?.staticFields || null;
  }

  // Concrete loaded classes assignable to `target` (class ids).
  subclassIds(target) {
    const ids = [];
    for (const name of Object.keys(this.jvm.classes)) {
      if (!this.isGuestClass(name) || this.isAbstract(name)) continue;
      if (this.jvm.isInstanceOfSync(name, target)) ids.push({ name, id: this.classId(name) });
    }
    return ids;
  }

  // ---- imports ----------------------------------------------------------
  hostImport(name, params, results) {
    const key = `h:${name}`;
    if (!this.imports.has(key)) {
      const impl = this.hostImpls()[name];
      if (!impl) throw new Error(`no host import ${name}`);
      this.imports.set(key, { field: name, params, results, impl });
    }
    return key;
  }

  siteImport(key, params, results, impl) {
    if (!this.imports.has(key)) this.imports.set(key, { field: key, params, results, impl });
    return key;
  }

  globalImport(key, valtype, mutable, value) {
    if (!this.globalImports.has(key)) this.globalImports.set(key, { valtype, mutable, value });
    return key;
  }

  hostImpls() {
    if (this._hostImpls) return this._hostImpls;
    const jvm = this.jvm, runtime = this.runtime, toJs = runtime.toJs, toWasm = (v) => runtime.toWasm(v);
    const throwJava = (type, message = null) => { throw { type, message }; };
    const isNull = (v) => v === null || v === undefined;
    const hostArray = (array) => {
      const value = toJs(array);
      if (isNull(value)) throwJava('java/lang/NullPointerException');
      return value;
    };
    const checkIndex = (value, index) => {
      if (index < 0 || index >= value.length) throwJava('java/lang/ArrayIndexOutOfBoundsException', `Index ${index} out of bounds for length ${value.length}`);
    };
    const load = (array, index) => { const value = hostArray(array); checkIndex(value, index); return value[index]; };
    const storeElement = (array, index, element) => { const value = hostArray(array); checkIndex(value, index); value[index] = element; };
    this._hostImpls = {
      ref_eq: (a, b) => (toJs(a) === toJs(b) ? 1 : 0),
      athrow: (exception) => { const value = toJs(exception); if (isNull(value)) throwJava('java/lang/NullPointerException'); throw value; },
      err_div0: () => throwJava('java/lang/ArithmeticException', '/ by zero'),
      err_aioob: (index, length) => throwJava('java/lang/ArrayIndexOutOfBoundsException', `Index ${index} out of bounds for length ${length}`),
      err_cce: (value, siteId) => {
        const object = toJs(value);
        const site = this.sites[siteId];
        throwJava('java/lang/ClassCastException', `class ${String(object?.type || typeof object).replace(/\//g, '.')} cannot be cast to class ${String(site?.target).replace(/\//g, '.')}`);
      },
      vmiss: (cls, siteId) => {
        const site = this.sites[siteId];
        throw new ClosedWorldError(`closed world: no admitted implementation for class id ${cls} at ${site?.where}`);
      },
      frem: (a, b) => a % b,
      drem: (a, b) => a % b,
      alen: (array) => hostArray(array).length,
      aload_I: (a, i) => { const v = load(a, i); return typeof v === 'boolean' ? (v ? 1 : 0) : v; },
      aload_J: (a, i) => load(a, i), aload_F: (a, i) => load(a, i), aload_D: (a, i) => load(a, i),
      astore_I: (a, i, v) => storeElement(a, i, v), astore_J: (a, i, v) => storeElement(a, i, v),
      astore_F: (a, i, v) => storeElement(a, i, v), astore_D: (a, i, v) => storeElement(a, i, v),
      aaload: (a, i) => toWasm(load(a, i)),
      aastore: (a, i, v) => storeElement(a, i, toJs(v)),
    };
    return this._hostImpls;
  }

  // JS value -> Wasm argument / result conversions by kind.
  fromJs(kind, value) {
    switch (kind) {
      case 'A': return this.runtime.toWasm(value);
      case 'I': return typeof value === 'boolean' ? (value ? 1 : 0) : (value === undefined ? 0 : value);
      case 'J': return typeof value === 'bigint' ? value : BigInt(value || 0);
      case 'V': return undefined;
      default: return value === undefined ? 0 : value;
    }
  }
  toJsValue(kind, value) { return kind === 'A' ? this.runtime.toJs(value) : value; }

  // A synchronous native call as an import: (receiver?, args...) -> result.
  nativeImport(key, native, descriptor, hasReceiver) {
    const { params, ret } = parseMethodDescriptor(descriptor);
    const kinds = params.map(kindOf), retKind = kindOf(ret);
    const wasmParams = [...(hasReceiver ? [VT.anyref] : []), ...kinds.map((k) => WT[k])];
    const world = this, jvm = this.jvm;
    const impl = (...wasmArgs) => {
      const receiver = hasReceiver ? world.runtime.toJs(wasmArgs[0]) : null;
      if (hasReceiver && (receiver === null || receiver === undefined)) throw { type: 'java/lang/NullPointerException', message: null };
      const offset = hasReceiver ? 1 : 0;
      const args = kinds.map((k, i) => world.toJsValue(k, wasmArgs[i + offset]));
      const result = native(jvm, receiver, args, world.thread);
      if (result && typeof result.then === 'function') {
        throw new ClosedWorldError(`closed world: host method ${key} returned a Promise`);
      }
      return world.fromJs(retKind, result);
    };
    return this.siteImport(key, wasmParams, retKind === 'V' ? [] : [WT[retKind]], impl);
  }

  // ---- admission ----------------------------------------------------------
  async build() {
    if (this.built) return;
    this.built = true;
    await this.loadReferencedClasses();
    const candidates = [];
    for (const className of Object.keys(this.jvm.classes)) {
      if (!this.isGuestClass(className)) continue;
      const ast = this.classAst(className);
      for (const item of ast.items) {
        if (item.type !== 'method') continue;
        const method = item.method;
        const key = `${className}.${method.name}${method.descriptor}`;
        const record = this.analyze(className, method, key);
        if (record) candidates.push(record);
      }
    }
    for (const record of candidates) this.entries.set(record.key, record);
    // Greatest fixed point: drop methods that call something not admitted.
    for (let changed = true; changed;) {
      changed = false;
      for (const [key, record] of this.entries) {
        const missing = [...record.calls].find((callee) => !this.entries.has(callee));
        if (missing) {
          this.entries.delete(key);
          this.rejected.set(key, `callee-not-admitted: ${missing}`);
          changed = true;
        }
      }
    }
    if (!this.entries.size) return;
    this.assemble();
  }

  // Load the classes admitted code may reference (without initializing them),
  // so admission sees every implementation and layout it needs.
  async loadReferencedClasses() {
    const jvm = this.jvm;
    const done = new Set();
    for (let round = 0; round < 8; round++) {
      const wanted = new Set();
      for (const className of Object.keys(jvm.classes)) {
        if (done.has(className) || !this.isGuestClass(className)) continue;
        done.add(className);
        const ast = this.classAst(className);
        if (ast.superClassName) wanted.add(ast.superClassName);
        for (const iface of ast.interfaces || []) wanted.add(iface);
        for (const item of ast.items) {
          if (item.type !== 'method') continue;
          const code = item.method.attributes?.find((a) => a.type === 'code')?.code;
          for (const codeItem of code?.codeItems || []) {
            const arg = codeItem.instruction?.arg;
            if (Array.isArray(arg) && typeof arg[1] === 'string') wanted.add(arg[1]);
            else if (typeof arg === 'string' && /^[A-Za-z_$][\w$/]*$/.test(arg) && arg.includes('/')) wanted.add(arg);
          }
        }
      }
      const missing = [...wanted].filter((name) => name && !name.startsWith('[') && !jvm.classes[name] && !(jvm.jre && jvm.jre[name]));
      if (!missing.length) break;
      for (const name of missing) {
        try { await jvm.loadClassByName(name); } catch { /* absent classes leave their users rejected */ }
      }
    }
  }

  reject(key, reason) {
    this.rejected.set(key, reason);
    return null;
  }

  analyze(className, method, key) {
    const flags = flagsOf(method);
    if (flags.includes('native') || flags.includes('abstract')) return null;
    if (flags.includes('synchronized')) return this.reject(key, 'synchronized');
    if (method.name === '<clinit>') return this.reject(key, 'clinit');
    const code = method.attributes?.find((a) => a.type === 'code')?.code;
    if (!code) return this.reject(key, 'no-code');
    if ((code.exceptionTable || []).length) return this.reject(key, 'exception-handlers');
    for (const item of code.codeItems || []) {
      const op = typeof item.instruction === 'string' ? item.instruction : item.instruction?.op;
      if (REJECT_OPS.has(op)) return this.reject(key, `op:${op}`);
    }
    let fn;
    try {
      fn = buildSsa({ codeItems: code.codeItems, exceptionTable: [], method, className });
    } catch (error) {
      return this.reject(key, `ssa-error: ${error.message}`);
    }
    if (fn.rejected) return this.reject(key, `ssa: ${fn.rejected}`);
    const { params, ret } = parseMethodDescriptor(method.descriptor);
    const isStatic = isStaticMethod(method);
    const record = {
      key, className, method, fn, isStatic,
      paramKinds: [...(isStatic ? [] : ['A']), ...params.map(kindOf)],
      paramDescriptors: params,
      returnKind: kindOf(ret),
      plan: new Map(),
      calls: new Set(),
      initClasses: new Set(),
    };
    try {
      for (const blockId of fn.reachable) {
        for (const node of fn.blocks[blockId].body) this.planNode(record, node);
      }
    } catch (error) {
      if (error instanceof Unsupported) return this.reject(key, error.message);
      throw error;
    }
    return record;
  }

  where(record, node) { return `${record.key}@${node.pc ?? '?'}`; }

  planNode(record, node) {
    const op = node.op, imm = node.imm, plan = record.plan;
    switch (op) {
      case 'getfield': case 'putfield': {
        const [, owner, [name, descriptor]] = imm;
        const layout = this.runtime.layout(owner);
        if (!layout) throw new Unsupported(`field-without-layout: ${owner}`);
        let declaring = owner, field = null;
        for (let current = owner; current && !field; current = this.classAst(current)?.superClassName) {
          field = layout.byKey.get(`${current}.${name}`) || null;
          declaring = current;
        }
        if (!field) throw new Unsupported(`field-unresolved: ${owner}.${name}`);
        plan.set(node.id, {
          kind: op === 'getfield' ? 'field-get' : 'field-put', reference: field.index !== undefined,
          index: field.index, offset: field.offset, slotKind: field.kind, valueKind: kindOf(descriptor), declaring,
        });
        return;
      }
      case 'getstatic': case 'putstatic': {
        const [, owner, [name, descriptor]] = imm;
        const declaring = this.staticFieldOwner(owner, name, descriptor);
        if (!declaring) throw new Unsupported(`static-unresolved: ${owner}.${name}`);
        const store = this.staticStore(declaring);
        if (!store || typeof store.cell !== 'function') throw new Unsupported(`static-store: ${declaring}`);
        const cell = store.cell(`${name}:${descriptor}`);
        if (!cell.closedGlobal) throw new Unsupported(`static-not-closed: ${declaring}.${name}`);
        const valueKind = kindOf(descriptor);
        const valtype = cell.closedType === 'anyref' ? [VT.anyref] : [WT[valueKind]];
        const global = this.globalImport(`s:${declaring}.${name}:${descriptor}`, valtype, true, cell.closedGlobal);
        record.initClasses.add(declaring);
        plan.set(node.id, { kind: op === 'getstatic' ? 'static-get' : 'static-put', global, valueKind });
        return;
      }
      case 'invokestatic': case 'invokespecial': case 'invokevirtual': case 'invokeinterface':
        this.planInvoke(record, node);
        return;
      case 'new': {
        const className = imm;
        if (!this.jvm.classes[className] && !(this.jvm.jre && this.jvm.jre[className])) throw new Unsupported(`new-unloaded: ${className}`);
        if (this.isGuestClass(className) && !this.runtime.layout(className)) throw new Unsupported(`new-without-layout: ${className}`);
        record.initClasses.add(className);
        const jit = this.jit;
        const fn = this.siteImport(`new:${className}`, [], [VT.anyref],
          () => this.runtime.toWasm(jit.allocateObject(className)));
        plan.set(node.id, { kind: 'import', fn, argKinds: [] });
        return;
      }
      case 'newarray': {
        const atype = typeof imm === 'number' ? NEWARRAY[imm] : imm;
        const { allocPrimitiveArray } = require('../../instructions/object');
        const fn = this.siteImport(`newarray:${atype}`, [VT.i32], [VT.anyref],
          (count) => this.runtime.toWasm(allocPrimitiveArray(this.jvm, atype, count)));
        plan.set(node.id, { kind: 'import', fn, argKinds: ['I'] });
        return;
      }
      case 'anewarray': {
        const { allocReferenceArray } = require('../../instructions/object');
        const fn = this.siteImport(`anewarray:${imm}`, [VT.i32], [VT.anyref],
          (count) => this.runtime.toWasm(allocReferenceArray(this.jvm, imm, count)));
        plan.set(node.id, { kind: 'import', fn, argKinds: ['I'] });
        return;
      }
      case 'multianewarray': {
        const className = Array.isArray(imm) ? imm[0] : imm;
        const dims = node.args.length;
        const { allocMultiArray } = require('../../instructions/object');
        const fn = this.siteImport(`multianewarray:${className}:${dims}`, new Array(dims).fill(VT.i32), [VT.anyref],
          (...counts) => this.runtime.toWasm(allocMultiArray(this.jvm, className, counts)));
        plan.set(node.id, { kind: 'import', fn, argKinds: new Array(dims).fill('I') });
        return;
      }
      case 'checkcast': case 'instanceof':
        plan.set(node.id, this.planTypeTest(record, node, op === 'checkcast'));
        return;
      case 'ldc': case 'ldc_w': {
        if (typeof imm === 'string' || imm instanceof String) {
          const value = this.jvm.internString(String(imm));
          const global = this.globalImport(`k:${this.globalImports.size}`, [VT.externref], false, value);
          plan.set(node.id, { kind: 'constant-global', global });
          return;
        }
        if (Array.isArray(imm) && imm[0] === 'Class') {
          const mirror = this.jvm.getClassObjectSync?.(imm[1]);
          if (!mirror) throw new Unsupported(`ldc-class: ${imm[1]}`);
          const global = this.globalImport(`k:${this.globalImports.size}`, [VT.externref], false, mirror);
          plan.set(node.id, { kind: 'constant-global', global });
          return;
        }
        return;
      }
      default:
        return;
    }
  }

  planInvoke(record, node) {
    const op = node.op;
    const [, owner, [name, descriptor]] = node.imm;
    const { params, ret } = parseMethodDescriptor(descriptor);
    const argKinds = [...(op === 'invokestatic' ? [] : ['A']), ...params.map(kindOf)];
    const returnKind = kindOf(ret);
    const where = this.where(record, node);
    if (op === 'invokestatic' && (owner === 'java/lang/Math' || owner === 'java/lang/StrictMath')) {
      const intrinsic = this.mathIntrinsic(name, descriptor);
      if (intrinsic) { record.plan.set(node.id, { ...intrinsic, argKinds }); return; }
    }
    if (op === 'invokestatic' || op === 'invokespecial') {
      if (op === 'invokespecial' && name === '<init>' && owner === 'java/lang/Object') {
        record.plan.set(node.id, { kind: 'noop' });
        return;
      }
      const target = this.resolveFrom(owner, name, descriptor, op === 'invokestatic');
      if (!target) throw new Unsupported(`invoke-unresolved: ${owner}.${name}${descriptor}`);
      if (op === 'invokestatic') record.initClasses.add(target.owner);
      if (target.native) {
        const fn = this.nativeImport(`native:${target.owner}.${name}${descriptor}`, target.native, descriptor, op !== 'invokestatic');
        record.plan.set(node.id, { kind: 'import', fn, argKinds });
        return;
      }
      if (!this.isGuestClass(target.owner)) throw new Unsupported(`invoke-nonguest: ${target.owner}.${name}`);
      const calleeKey = `${target.owner}.${name}${descriptor}`;
      record.calls.add(calleeKey);
      record.plan.set(node.id, { kind: 'call', fn: `m:${calleeKey}`, argKinds,
        nullCheckReceiver: op === 'invokespecial' && name !== '<init>' });
      return;
    }
    // invokevirtual / invokeinterface: class-hierarchy analysis over loaded
    // concrete guest classes; host receivers allowed when the static type
    // admits JRE instances.
    const hostCapable = !this.isGuestClass(owner);
    const arms = new Map();
    for (const { name: className, id } of this.subclassIds(owner)) {
      const impl = this.resolveVirtual(className, name, descriptor);
      if (!impl) throw new Unsupported(`virtual-unresolved: ${className}.${name}${descriptor}`);
      let fn;
      if (impl.native) {
        fn = this.nativeImport(`native:${impl.owner}.${name}${descriptor}`, impl.native, descriptor, true);
      } else {
        if (!this.isGuestClass(impl.owner)) throw new Unsupported(`virtual-nonguest: ${impl.owner}.${name}`);
        fn = `m:${impl.owner}.${name}${descriptor}`;
        record.calls.add(`${impl.owner}.${name}${descriptor}`);
      }
      if (!arms.has(fn)) arms.set(fn, []);
      arms.get(fn).push(id);
    }
    if (arms.size > 16) throw new Unsupported(`megamorphic: ${owner}.${name}`);
    let hostFn = null;
    if (hostCapable) {
      const world = this;
      const { resolveVirtualHost } = this;
      hostFn = this.siteImport(`vhost:${owner}.${name}${descriptor}`, argKinds.map((k) => WT[k]),
        returnKind === 'V' ? [] : [WT[returnKind]], (...wasmArgs) => {
          const receiver = world.runtime.toJs(wasmArgs[0]);
          if (receiver === null || receiver === undefined) throw { type: 'java/lang/NullPointerException', message: null };
          const native = resolveVirtualHost.call(world, receiver, owner, name, descriptor);
          const args = params.map((p, i) => world.toJsValue(kindOf(p), wasmArgs[i + 1]));
          const result = native(world.jvm, receiver, args, world.thread);
          if (result && typeof result.then === 'function') throw new ClosedWorldError(`closed world: host virtual ${owner}.${name} returned a Promise`);
          return world.fromJs(returnKind, result);
        });
    }
    const siteId = this.sites.push({ where, target: `${owner}.${name}${descriptor}` }) - 1;
    record.plan.set(node.id, {
      kind: 'virtual', argKinds, returnKind, siteId, hostFn,
      targets: [...arms].map(([fn, classIds]) => ({ fn, classIds })),
    });
  }

  // java.lang.Math/StrictMath without the shim adapter. Native Wasm where
  // the operation is bit-exact with Java (IEEE abs/min/max/sqrt/floor/ceil/
  // rint, integer abs/min/max); otherwise the JS Math builtin imported
  // directly, which is the function every other jvm.js tier already uses.
  mathIntrinsic(name, descriptor) {
    const native = {
      'sqrt(D)D': 'f64.sqrt', 'abs(F)F': 'f32.abs', 'abs(D)D': 'f64.abs', 'floor(D)D': 'f64.floor',
      'ceil(D)D': 'f64.ceil', 'rint(D)D': 'f64.nearest', 'min(FF)F': 'f32.min', 'max(FF)F': 'f32.max',
      'min(DD)D': 'f64.min', 'max(DD)D': 'f64.max', 'abs(I)I': 'i32.abs', 'abs(J)J': 'i64.abs',
      'min(II)I': 'i32.min', 'max(II)I': 'i32.max', 'min(JJ)J': 'i64.min', 'max(JJ)J': 'i64.max',
    }[name + descriptor];
    if (native) return { kind: 'intrinsic', op: native };
    const unary = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'log10', 'cbrt', 'sinh', 'cosh', 'tanh', 'expm1', 'log1p'];
    const binary = ['atan2', 'pow', 'hypot'];
    if (descriptor === '(D)D' && unary.includes(name)) {
      return { kind: 'import', fn: this.siteImport(`math:${name}`, [VT.f64], [VT.f64], Math[name]) };
    }
    if (descriptor === '(DD)D' && binary.includes(name)) {
      return { kind: 'import', fn: this.siteImport(`math:${name}`, [VT.f64, VT.f64], [VT.f64], Math[name]) };
    }
    return null;
  }

  resolveVirtualHost(receiver, owner, name, descriptor) {
    const { runtimeClassName } = require('../../instructions/object');
    const className = runtimeClassName(receiver);
    let current = className || owner;
    while (current) {
      const native = this.jvm._jreFindMethod(current, name, descriptor);
      if (native) return native;
      const data = this.jvm.classes[current];
      current = this.jvm.jre?.[current]?.super || data?.ast?.classes?.[0]?.superClassName || null;
    }
    // java/lang/Object methods on strings and other host values.
    const native = this.jvm._jreFindMethod('java/lang/Object', name, descriptor);
    if (native) return native;
    throw new ClosedWorldError(`closed world: no host implementation of ${owner}.${name}${descriptor} for ${className}`);
  }

  planTypeTest(record, node, isCast) {
    const target = node.imm;
    const siteId = this.sites.push({ where: this.where(record, node), target }) - 1;
    if (target === 'java/lang/Object') return { kind: isCast ? 'checkcast' : 'instanceof', always: true, siteId };
    if (/^\[[ZBCSIJFD]$/.test(target)) {
      return { kind: isCast ? 'checkcast' : 'instanceof', primitiveKind: require('./representation').KIND[target], siteId };
    }
    if (this.isGuestClass(target)) {
      const classIds = this.subclassIds(target).map((c) => c.id);
      if (classIds.length <= 32) return { kind: isCast ? 'checkcast' : 'instanceof', classIds, siteId };
    }
    const jvm = this.jvm, runtime = this.runtime;
    const { runtimeClassName } = require('../../instructions/object');
    const hostFn = this.siteImport(`isa:${target}`, [VT.anyref], [VT.i32], (value) => {
      const object = runtime.toJs(value);
      return object !== null && object !== undefined && jvm.isInstanceOfSync(runtimeClassName(object), target) ? 1 : 0;
    });
    return { kind: isCast ? 'checkcast' : 'instanceof', hostFn, siteId };
  }

  // ---- module assembly ----------------------------------------------------
  assemble() {
    // Compile bodies first: they register the imports they need.
    const bodies = new Map();
    for (let pass = 0; pass < 2; pass++) {
      for (const [key, record] of this.entries) {
        if (bodies.has(key)) continue;
        try {
          bodies.set(key, new ClosedCompiler(this, record).compile());
        } catch (error) {
          if (!(error instanceof Unsupported)) throw error;
          this.entries.delete(key);
          this.rejected.set(key, `compile: ${error.message}`);
        }
      }
      // A compile rejection can strand callers; recompute the fixed point.
      let changed = false;
      for (const [key, record] of this.entries) {
        const missing = [...record.calls].find((callee) => !this.entries.has(callee));
        if (missing) {
          this.entries.delete(key);
          bodies.delete(key);
          this.rejected.set(key, `callee-not-admitted: ${missing}`);
          changed = true;
        }
      }
      if (!changed) break;
      if (pass === 1) throw new Error('closed world: admission did not settle');
    }
    for (const key of [...bodies.keys()]) if (!this.entries.has(key)) bodies.delete(key);
    if (!this.entries.size) return;

    const builder = new ModuleBuilder();
    builder.addRecGroup('closed', closedTypes());
    builder.importMemory('c', 'mem', this.runtime.heap.memory.buffer.byteLength >>> 16);
    const importObject = { c: { mem: this.runtime.heap.memory }, s: {}, f: {} };
    let globalIndex = 0;
    for (const [key, g] of this.globalImports) {
      const field = `g${globalIndex++}`;
      builder.importGlobal('s', field, g.valtype, g.mutable, key);
      importObject.s[field] = g.mutable ? g.value : new WebAssembly.Global({ value: 'externref', mutable: false }, g.value);
    }
    let importIndex = 0;
    const countImports = process.env?.JVM_CLOSED_WORLD_STATS === 'imports';
    if (countImports) this.importCalls = new Map();
    for (const [key, imp] of this.imports) {
      const field = `f${importIndex++}`;
      builder.importFunction('f', field, imp.params.map((p) => [p]), imp.results.map((r) => [r]), key);
      if (countImports) {
        const calls = this.importCalls, impl = imp.impl;
        calls.set(key, 0);
        importObject.f[field] = (...args) => { calls.set(key, calls.get(key) + 1); return impl(...args); };
      } else {
        importObject.f[field] = imp.impl;
      }
    }
    let exportIndex = 0;
    for (const [key, record] of this.entries) {
      record.exportName = `m${exportIndex++}`;
      builder.declareFunction(`m:${key}`, record.paramKinds.map((k) => [WT[k]]),
        record.returnKind === 'V' ? [] : [[WT[record.returnKind]]]);
      builder.exportFunction(record.exportName, `m:${key}`);
    }
    for (const [key, body] of bodies) builder.defineFunction(`m:${key}`, body.locals, body.code);
    const bytes = builder.build();
    this.moduleBytes = bytes.length;
    if (process.env.JVM_CLOSED_WORLD_DUMP) require('node:fs').writeFileSync(process.env.JVM_CLOSED_WORLD_DUMP, bytes);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), importObject);
    this.instance = instance;
    for (const record of this.entries.values()) {
      record.fn = instance.exports[record.exportName];
      record.ready = false;
      record.readinessClasses = null;
      this.entryByMethod.set(record.method, record);
      // Release the SSA: execution needs only the export and its signature.
      record.ssa = undefined;
      record.plan = undefined;
    }
    for (const record of this.entries.values()) record.fnSsa = undefined;
  }

  // Classes the admitted closure of `record` may initialize.
  readinessClasses(record) {
    if (record.readinessClasses) return record.readinessClasses;
    const classes = new Set(), seen = new Set(), stack = [record];
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current.key)) continue;
      seen.add(current.key);
      for (const c of current.initClasses) classes.add(c);
      for (const callee of current.calls) {
        const next = this.entries.get(callee);
        if (next) stack.push(next);
      }
    }
    record.readinessClasses = [...classes];
    return record.readinessClasses;
  }

  isReady(record) {
    if (record.ready) return true;
    const state = this.jvm.classInitializationState;
    for (const className of this.readinessClasses(record)) {
      if (this.jvm.jre && this.jvm.jre[className] && !this.jvm.classes[className]?.ast) continue;
      if (state.get(className) !== 'INITIALIZED') return false;
    }
    record.ready = true;
    return true;
  }

  // ---- entry adapters ---------------------------------------------------
  translateTrap(error) {
    if (error instanceof WebAssembly.RuntimeError && /null/i.test(error.message)) {
      return { type: 'java/lang/NullPointerException', message: null };
    }
    if (error instanceof WebAssembly.RuntimeError && !this.reportedTrap) {
      // Any other trap is a closed-world defect, never Java semantics.
      this.reportedTrap = true;
      process.stderr.write(`[closed-world] trap: ${error.stack}\n`);
    }
    return error;
  }

  invokeEntry(record, wasmArgs, thread) {
    const previous = this.thread;
    this.thread = thread;
    this.counters.entries += 1;
    try {
      return record.fn(...wasmArgs);
    } catch (error) {
      throw this.translateTrap(error);
    } finally {
      this.thread = previous;
    }
  }

  // Scheduler entry: a frame at pc 0 of an admitted, ready method.
  tryRunFrame(frame, thread) {
    if (frame.pc !== 0) return null;
    const record = this.entryByMethod.get(frame.method);
    if (!record) return null;
    if (!this.isReady(record)) { this.counters.notReady += 1; return null; }
    const args = new Array(record.paramKinds.length);
    let slot = 0;
    for (let i = 0; i < record.paramKinds.length; i++) {
      const kind = record.paramKinds[i];
      args[i] = this.fromJs(kind, frame.locals[slot]);
      slot += kind === 'J' || kind === 'D' ? 2 : 1;
    }
    const result = this.invokeEntry(record, args, thread);
    thread.callStack.pop();
    if (record.returnKind !== 'V' && !thread.callStack.isEmpty()) {
      thread.callStack.peek().stack.push(this.toJsValue(record.returnKind, result));
    }
    return { handled: true, returned: true };
  }

  // Synchronous call from generated JS code: consumes the operands.
  tryInvoke(method, frame, thread) {
    const record = this.entryByMethod.get(method);
    if (!record || !this.isReady(record)) return NOT_CLOSED;
    const items = frame.stack.items;
    const count = record.paramKinds.length;
    const base = items.length - count;
    if (base < 0) return NOT_CLOSED;
    const args = new Array(count);
    for (let i = 0; i < count; i++) args[i] = this.fromJs(record.paramKinds[i], items[base + i]);
    items.length = base;
    const result = this.invokeEntry(record, args, thread);
    return record.returnKind === 'V' ? undefined : this.toJsValue(record.returnKind, result);
  }
}

const NOT_CLOSED = Symbol('closed.not-closed');

module.exports = { ClosedWorld, ClosedWorldError, NOT_CLOSED, parseMethodDescriptor, kindOf };
