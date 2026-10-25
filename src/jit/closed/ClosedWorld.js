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

const { buildSsa, resolveHandlerRanges } = require('../../analysis/opgraph/ssa');
const { VT, OP, GC, ModuleBuilder, structType, subType, refNull, ref, uleb, sleb } = require('./wasmBuilder');
const { closedTypes, OBJ_FIELDS, T_OBJ, T_PARR, T_RARR, T_REFS } = require('./representation');
const { ClosedCompiler, Unsupported, WT } = require('./ClosedCompiler');
const { ASYNC_METHOD_SENTINEL } = require('../../core/constants');

// Longest a thread runs in the module before it is parked at a host call.
const SLICE_MS = 10;
const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
const REJECT_OPS = new Set(['jsr', 'jsr_w', 'ret', 'invokedynamic']);
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
    this.counters = { entries: 0, entryFallbacks: 0, notReady: 0, preempted: 0 };
    this.sliceStart = 0;
    this.thread = null;
    // Java exceptions inside the module are this tag with the exception as
    // payload; host imports convert whatever JS throws into it.
    this.tag = new WebAssembly.Tag({ parameters: ['anyref'] });
    // JS Promise Integration: a scheduler entry runs on its own suspendable
    // stack, so a thread that has to stop inside the module (sleep, wait, a
    // contended monitor, an asynchronous native) parks there and resumes at
    // the same instruction. See park().
    this.jspi = jspiAvailable();
    this.syncDepth = 0;
    this.pendingPark = null;
    // With suspension, an asynchronous native is just another park point.
    this.optimisticAsync = jit.closedWorldOptimisticAsync ?? (this.jspi ||
      (typeof process !== 'undefined' && process.env?.JVM_CLOSED_WORLD_OPTIMISTIC_ASYNC === '1'));
    if (typeof process !== 'undefined' && process.env?.JVM_CLOSED_WORLD_STATS) {
      process.once('exit', () => {
        const rejected = [...this.rejected].map(([key, reason]) => `${key}\t${reason}`).join('\n');
        // Synchronous: an asynchronous pipe write is truncated at exit.
        const write = (text) => require('fs').writeSync(2, text);
        write(`[closed-world] ${JSON.stringify(this.stats())}\n`);
        if (process.env.JVM_CLOSED_WORLD_STATS === 'rejects') write(`${rejected}\n`);
        if (this.importCalls) {
          const top = [...this.importCalls].filter(([, n]) => n).sort((x, y) => y[1] - x[1]).slice(0, 40);
          write(top.map(([key, n]) => `[closed-import] ${n}\t${key}`).join('\n') + '\n');
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
      optimisticAsyncSites: this.optimisticAsyncSites || 0,
      adoptedArrays: this.runtime.adoptedArrays,
      ...this.counters,
    };
  }

  // ---- class model helpers ----------------------------------------------
  classAst(name) { return this.jvm.classes[name]?.ast?.classes?.[0] || null; }
  // Guest bytecode. An application-fallback JRE entry only overrides some
  // methods with natives; the class itself is still guest code.
  isGuestClass(name) {
    const data = this.jvm.classes[name];
    const jre = this.jvm.jre && this.jvm.jre[name];
    return !!(data && data.ast && !data.isJreStub && (!jre || jre.applicationFallback));
  }
  isInterface(name) {
    const ast = this.classAst(name);
    return !!ast && (ast.flags || []).includes('interface');
  }
  isAbstract(name) {
    const ast = this.classAst(name);
    return !!ast && ((ast.flags || []).includes('abstract') || (ast.flags || []).includes('interface'));
  }
  // Closed representation every value of a Java static type has inside the
  // module: 'obj' ($obj), 'parr' ($parr), 'rarr' ($rarr), or 'any' (anyref:
  // host values possible). Arrays are always closed storage (foreign arrays
  // are adopted when they cross in); a guest class with a closed layout and
  // no JRE shim only ever has closed instances.
  // One Wasm struct type per guest class with a closed layout, a subtype of
  // its superclass's (or $obj), holding the class chain's reference fields
  // in layout order after the $obj prefix. Superclasses come first.
  prepareClassTypes() {
    const types = new Map();
    const visit = (name) => {
      if (types.has(name)) return types.get(name);
      if (!this.isGuestClass(name) || this.isInterface(name)) return null;
      const layout = this.runtime.layout(name);
      if (!layout) return null;
      const superName = this.classAst(name)?.superClassName;
      const parent = superName ? visit(superName) : null;
      const entry = { name, layout, parent, index: types.size, key: `classes:${types.size}` };
      types.set(name, entry);
      return entry;
    };
    for (const name of Object.keys(this.jvm.classes)) visit(name);
    this.classTypes = types;
  }

  isSubclass(name, ancestor) {
    for (let current = name; current; current = this.classAst(current)?.superClassName) {
      if (current === ancestor) return true;
    }
    return false;
  }

  // Representation lattice: 'obj:C' <: 'obj' (some closed object) <: 'any';
  // 'parr', 'rarr' <: 'any'; 'null' <: everything.
  reprSubtype(a, b) {
    if (a === b || b === 'any' || a === 'null') return true;
    if (b === 'obj') return a.startsWith('obj:');
    if (a.startsWith('obj:') && b.startsWith('obj:')) return this.isSubclass(a.slice(4), b.slice(4));
    return false;
  }

  reprJoin(a, b) {
    if (!a || a === 'null') return b;
    if (!b || b === 'null') return a;
    if (a === b) return a;
    if (a.startsWith('obj') && b.startsWith('obj')) {
      if (a === 'obj' || b === 'obj') return 'obj';
      for (let current = a.slice(4); current; current = this.classAst(current)?.superClassName) {
        if (this.isSubclass(b.slice(4), current)) return this.classTypes?.has(current) ? `obj:${current}` : 'obj';
      }
      return 'obj';
    }
    return 'any';
  }

  // Wasm value type of a value of `kind` with representation `repr`.
  wasmType(kind, repr) {
    const type = kind === 'A' && repr ? this.typeOfRepr(repr) : null;
    return type ? refNull(type) : [WT[kind]];
  }

  // Heap type marker of a typed representation.
  typeOfRepr(repr) {
    if (repr === 'parr') return T_PARR;
    if (repr === 'rarr') return T_RARR;
    if (repr === 'obj') return T_OBJ;
    if (repr.startsWith('obj:')) return this.classTypes.get(repr.slice(4)).key;
    return null;
  }

  reprOfDescriptor(descriptor) {
    if (!descriptor) return 'any';
    this.reprCache ||= new Map();
    let repr = this.reprCache.get(descriptor);
    if (repr !== undefined) return repr;
    if (descriptor[0] === '[') repr = /^\[[ZBCSIJFD]$/.test(descriptor) ? 'parr' : 'rarr';
    else if (descriptor[0] === 'L') repr = this.reprOfClass(descriptor.slice(1, -1));
    else repr = 'any';
    this.reprCache.set(descriptor, repr);
    return repr;
  }

  reprOfClass(className) {
    if (!this.isGuestClass(className) || (this.jvm.jre && this.jvm.jre[className]) || this.isInterface(className)) return 'any';
    return this.classTypes?.has(className) ? `obj:${className}` : 'any';
  }

  classId(name) { return (this.objectModel ||= require('../../core/objectModel')).classIndexOf(this.jvm, name); }

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

  // An import that never throws: bound directly, with no conversion wrapper.
  pureImport(key, params, results, impl) {
    if (!this.imports.has(key)) this.imports.set(key, { field: key, params, results, impl, pure: true });
    return key;
  }

  // A static field the module defines (and exports for its cell to rebind to).
  staticGlobal(key, valtype, cell) {
    this.staticGlobals ||= new Map();
    if (!this.staticGlobals.has(key)) this.staticGlobals.set(key, { valtype, cell });
    return key;
  }

  globalImport(key, valtype, mutable, value) {
    if (!this.globalImports.has(key)) this.globalImports.set(key, { valtype, mutable, value });
    return key;
  }

  hostImpls() {
    if (this._hostImpls) return this._hostImpls;
    const jvm = this.jvm, runtime = this.runtime, toJs = runtime.toJs, toWasm = (v) => runtime.toWasm(v);
    const tag = this.tag, world = this;
    const throwJava = (type, message = null) => { throw new WebAssembly.Exception(tag, [{ type, message }]); };
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
      err_npe: () => throwJava('java/lang/NullPointerException'),
      err_soe: () => throwJava('java/lang/StackOverflowError'),
      err_npe_invoke: (siteId) => {
        const { items, item, owner, name } = this.sites[siteId].npe;
        throw new WebAssembly.Exception(tag, [{ type: 'java/lang/NullPointerException', message: null,
          context: { frame: { instructions: items }, pc: item.pc, className: owner, methodName: name } }]);
      },
      err_npe_at: (site) => {
        process.stderr.write(`[closed-world] NullPointerException at ${this.sites[site]?.where}\n`);
        throwJava('java/lang/NullPointerException');
      },
      init: (id) => world.initializeSync(id),
      menter: (value) => {
        const monitor = toJs(value), thread = world.thread;
        if (isNull(monitor)) throwJava('java/lang/NullPointerException');
        // Park as BLOCKED; the scheduler makes the thread runnable once the
        // owner releases, and the retry takes the monitor.
        const acquire = () => {
          if (!monitor.isLocked) {
            monitor.isLocked = true; monitor.lockOwner = thread.id; monitor.lockCount = 1;
            thread.blockingOn = undefined;
            return true;
          }
          thread.status = 'BLOCKED'; thread.blockingOn = monitor;
          return false;
        };
        // A thread out of time gives way before it takes a free monitor, so
        // waiters (a notified thread reacquiring it) can run first.
        if (!monitor.isLocked && world.sliceExpired() && world.requestPark({ value: undefined, retry: acquire })) {
          world.counters.preempted += 1;
          return;
        }
        if (!monitor.isLocked) { monitor.isLocked = true; monitor.lockOwner = thread.id; monitor.lockCount = 1; }
        else if (monitor.lockOwner === thread.id) monitor.lockCount++;
        else {
          if (!world.requestPark({ value: undefined, retry: acquire })) {
            throw new ClosedWorldError('closed world: contended monitor (module code cannot block)');
          }
          thread.status = 'BLOCKED'; thread.blockingOn = monitor;
        }
      },
      mexit: (value) => {
        const monitor = toJs(value), thread = world.thread;
        if (isNull(monitor)) throwJava('java/lang/NullPointerException');
        if (!monitor.isLocked || monitor.lockOwner !== thread.id) throwJava('java/lang/IllegalMonitorStateException');
        if (--monitor.lockCount === 0) { monitor.isLocked = false; monitor.lockOwner = null; }
      },
      athrow: (exception) => { const value = toJs(exception); if (isNull(value)) throwJava('java/lang/NullPointerException'); throw value; },
      err_div0: () => throwJava('java/lang/ArithmeticException', '/ by zero'),
      err_aioob: (index, length) => throwJava('java/lang/ArrayIndexOutOfBoundsException', `Index ${index} out of bounds for length ${length}`),
      err_index: (array, index) => { const value = hostArray(array); checkIndex(value, index); },
      err_foreign: (array) => {
        const value = toJs(array);
        throw new ClosedWorldError(`closed world: ${value?.type || typeof value} array outside closed storage reached module code`);
      },
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

  // Catch-type test, matching jvm.js handler dispatch (isInstanceOf on .type).
  exceptionTypeImport(type) {
    const jvm = this.jvm, runtime = this.runtime;
    return this.siteImport(`exc:${type}`, [VT.anyref], [VT.i32], (payload) => {
      const exception = runtime.toJs(payload);
      return exception && jvm.isInstanceOf(exception.type, type) ? 1 : 0;
    });
  }

  // A host import's JS throw as a module exception. Internal JS errors stay
  // JS errors: they must fail loudly, never reach a Java handler.
  hostThrow(error) {
    if (error instanceof WebAssembly.Exception || error instanceof Error) return error;
    return new WebAssembly.Exception(this.tag, [this.runtime.toWasm(error)]);
  }

  wrapHost(impl, arity) {
    const world = this;
    switch (arity) {
      case 0: return () => { try { return impl(); } catch (e) { throw world.hostThrow(e); } };
      case 1: return (a) => { try { return impl(a); } catch (e) { throw world.hostThrow(e); } };
      case 2: return (a, b) => { try { return impl(a, b); } catch (e) { throw world.hostThrow(e); } };
      case 3: return (a, b, c) => { try { return impl(a, b, c); } catch (e) { throw world.hostThrow(e); } };
      default: return (...args) => { try { return impl(...args); } catch (e) { throw world.hostThrow(e); } };
    }
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

  // An asynchronous native is a suspension point; module code cannot wait
  // for it, so whoever can reach it stays on the suspending tiers.
  //
  // Obfuscated code defeats this static rule: opaque dummy-parameter branches
  // connect nearly every method to sockets, files and reflection, so one
  // async native excludes almost everything. With `optimisticAsync`
  // (JVM_CLOSED_WORLD_OPTIMISTIC_ASYNC=1) such calls are admitted and an
  // async native that actually runs inside the module fails loudly at run
  // time instead. Real suspension inside the module is not implemented.
  rejectAsyncNative(native, where) {
    if (native && native.constructor && native.constructor.name === 'AsyncFunction') {
      if (this.optimisticAsync) { this.optimisticAsyncSites = (this.optimisticAsyncSites || 0) + 1; return; }
      throw new Unsupported(`async-native: ${where}`);
    }
  }

  // A host call's result as a Wasm value, or a park request when the call
  // asked this thread to stop (sleep, wait) or returned a Promise. The call
  // site checks the module's park flag right after the call and, when it is
  // set, calls the suspending park import, which returns the real result.
  hostResult(kind, result, where, returnDesc) {
    if (result && typeof result.then === 'function') {
      if (this.requestPark({ promise: result, kind, returnDesc })) return parkDummy(kind);
      throw new ClosedWorldError(`closed world: host method ${where} returned a Promise`);
    }
    // The native pushed a guest frame (reflection, method handles, Thread
    // starts); what it returns lands on the entry frame's operand stack.
    if (result === ASYNC_METHOD_SENTINEL) {
      if (this.requestPark({ frameResult: kind })) return parkDummy(kind);
      throw new ClosedWorldError(`closed world: host method ${where} pushed a frame and this entry cannot park`);
    }
    const thread = this.thread;
    // A native that pushed guest frames (doClick runs its listeners) expects
    // them to run before its caller continues.
    if (thread && thread.closedEntryFrame && thread.callStack.peek() !== thread.closedEntryFrame
        && this.requestPark({ value: this.fromHost(kind, result, returnDesc) })) {
      return parkDummy(kind);
    }
    if (thread && thread.status !== 'runnable') {
      if (this.requestPark({ value: this.fromHost(kind, result, returnDesc) })) return parkDummy(kind);
      throw new ClosedWorldError(`closed world: host method ${where} asked thread ${thread.id} to ${thread.status}`);
    }
    if (this.sliceExpired() && this.requestPark({ value: this.fromHost(kind, result, returnDesc) })) {
      this.counters.preempted += 1;
      return parkDummy(kind);
    }
    return this.fromHost(kind, result, returnDesc);
  }

  // Module code runs a thread until it parks. A guest loop that never blocks
  // (a game loop running behind schedule never sleeps) would hold the event
  // loop and starve every other thread, so a thread that has run for a time
  // slice is parked at its next host call and goes back to the scheduler.
  sliceExpired() {
    return this.jspi && now() - this.sliceStart > SLICE_MS;
  }

  // JRE natives may return a bare JS array for a Java array result. The
  // interpreter tolerates that, but closed storage needs the array's type to
  // adopt it, and the declared return type is that type.
  fromHost(kind, result, returnDesc) {
    if (kind === 'A' && returnDesc && returnDesc[0] === '[' && result && typeof result === 'object'
        && typeof result.type !== 'string' && (Array.isArray(result) || ArrayBuffer.isView(result))) {
      result.type = returnDesc;
    }
    return this.fromJs(kind, result);
  }

  // Parking needs a suspendable stack with no JS frame between it and the
  // module: a promising scheduler entry, not a synchronous nested one.
  requestPark(request) {
    if (!this.jspi || !this.parkFlag || this.syncDepth !== 0 || !this.thread?.closedEntryFrame) return false;
    this.pendingPark = request;
    this.parkFlag.value = 1;
    return true;
  }

  // The suspending import behind every park check, one per result type.
  parkImport(kind) {
    const key = `park:${kind}`;
    if (!this.imports.has(key)) {
      const world = this;
      this.imports.set(key, { field: key, params: [], results: kind === 'V' ? [] : [WT[kind]], suspending: true,
        impl: () => world.park(kind) });
    }
    return key;
  }

  // Other threads enter the module while this one is parked; the depth
  // counter is per thread, so it comes back with the continuation.
  async park(kind) {
    const depth = this.getDepth();
    try { return await this.parkFor(kind); } finally { this.setDepth(depth); }
  }

  async parkFor(kind) {
    const request = this.pendingPark, thread = this.thread;
    this.pendingPark = null;
    this.parkFlag.value = 0;
    this.counters.parks = (this.counters.parks || 0) + 1;
    if (request.promise) {
      // An asynchronous native holds the scheduler, exactly as it does for
      // an interpreted caller: the tick that entered the module is pending.
      // A native can run guest frames above the entry frame (newInstance runs
      // the constructor); an exception they leave lands on the entry frame.
      const frame = thread.closedEntryFrame;
      frame.closedAwaiting = true;
      let value;
      try { value = await request.promise; } catch (error) { throw this.hostThrow(error); } finally {
        frame.closedAwaiting = undefined;
        this.thread = thread;
      }
      const outcome = frame.closedResumeWith;
      frame.closedResumeWith = undefined;
      if (outcome && 'thrown' in outcome) throw this.hostThrow(outcome.thrown);
      if (value === ASYNC_METHOD_SENTINEL) return this.frameResult(kind, thread);
      const result = this.fromHost(kind, value, request.returnDesc);
      if (thread.callStack.peek() !== frame) {
        const pushed = await this.yieldThread(thread);
        if (pushed && 'thrown' in pushed) throw this.hostThrow(pushed.thrown);
      }
      return result;
    }
    if (request.frameResult) return this.frameResult(request.frameResult, thread);
    if (request.invoke) return this.parkedInvoke(request, thread);
    if (request.init) return this.parkedInit(request.init, thread);
    for (;;) {
      const outcome = await this.yieldThread(thread);
      if (outcome && 'thrown' in outcome) throw this.hostThrow(outcome.thrown);
      if (!request.retry || request.retry()) return request.value;
    }
  }

  // A native pushed a guest frame: run it, then take its return value from
  // the entry frame's operand stack.
  async frameResult(kind, thread) {
    const entry = thread.closedEntryFrame;
    const outcome = await this.yieldThread(thread);
    if (outcome && 'thrown' in outcome) throw this.hostThrow(outcome.thrown);
    if (kind === 'V') return undefined;
    return this.fromJs(kind, entry.stack.isEmpty() ? null : entry.stack.pop());
  }

  // The callee runs as an ordinary frame above the parked entry frame; its
  // return value lands on the entry frame's operand stack, an exception that
  // reaches the entry frame comes back here (JVM.handleException).
  async parkedInvoke(request, thread) {
    const signature = request.invoke, entry = thread.closedEntryFrame;
    const Frame = (this.Frame ||= require('../../core/frame'));
    const frame = new Frame(signature.method);
    frame.className = signature.className;
    if (request.onStack) {
      // A synthetic invoke frame: the operands its one instruction pops.
      for (const value of request.args) frame.stack.push(value);
      frame.jitJsDisabled = true;
    } else {
      let slot = 0;
      signature.paramKinds.forEach((kind, i) => {
        frame.locals[slot] = request.args[i];
        slot += kind === 'J' || kind === 'D' ? 2 : 1;
      });
    }
    thread.callStack.push(frame);
    this.counters.slowCalls = (this.counters.slowCalls || 0) + 1;
    const outcome = await this.yieldThread(thread);
    if (outcome && 'thrown' in outcome) throw this.hostThrow(outcome.thrown);
    return signature.returnKind === 'V' ? undefined : this.fromJs(signature.returnKind, entry.stack.pop());
  }

  async parkedInit(className, thread) {
    const jvm = this.jvm;
    for (;;) {
      if (jvm.classInitializationState.get(className) === 'INITIALIZED') return;
      let pushed;
      try { pushed = await jvm.initializeClassIfNeeded(className, thread); } catch (error) { throw this.hostThrow(error); } finally { this.thread = thread; }
      if (!pushed) return;
      const outcome = await this.yieldThread(thread);
      if (outcome && 'thrown' in outcome) throw this.hostThrow(outcome.thrown);
    }
  }

  // JVM.handleException found the parked entry frame on top: the exception
  // came out of a frame the module was waiting for, so the module throws it.
  deliverException(frame, exception) {
    frame.closedResumeWith = { thrown: exception };
    return true;
  }

  // End this scheduler tick with the thread parked in the module; the next
  // tick that finds the entry frame on top resumes it.
  yieldThread(thread) {
    const frame = thread.closedEntryFrame;
    return new Promise((resume) => {
      frame.closedPark = resume;
      endSegment(frame, PARKED);
    });
  }

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
      return world.hostResult(retKind, result, key, ret);
    };
    return this.siteImport(key, wasmParams, retKind === 'V' ? [] : [WT[retKind]], impl);
  }

  // ---- admission ----------------------------------------------------------
  async build(thread = null) {
    if (this.built) return;
    this.built = true;
    if (typeof this.jvm.preloadClasspathClasses === 'function') {
      try { await this.jvm.preloadClasspathClasses(null, { scope: this.jvm.prepareScope }); } catch { /* referenced classes still load below */ }
    }
    await this.loadReferencedClasses();
    this.prepareClassTypes();
    this.knownClassLimit = this.computeKnownClassLimit();
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
    // With JSPI such a call is a stub that runs the callee as an ordinary
    // frame (see slowCallStub), so nothing is dropped.
    for (let changed = !this.jspi; changed;) {
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
    if (thread) await this.initializeTrivialClasses(thread);
  }

  // A class with no <clinit> anywhere up its guest superclass chain has no
  // observable initialization, so initializing it early is invisible to Java.
  // Doing so keeps it from holding an admitted closure back from readiness.
  async initializeTrivialClasses(thread) {
    const wanted = new Set();
    for (const record of this.entries.values()) for (const c of this.readinessClasses(record)) wanted.add(c);
    const trivial = (name, seen = new Set()) => {
      if (seen.has(name)) return true;
      seen.add(name);
      if (this.jvm.classInitializationState.get(name) === 'INITIALIZED') return true;
      if (!this.isGuestClass(name)) return false;
      const ast = this.classAst(name);
      if (ast.items.some((item) => item.type === 'method' && item.method.name === '<clinit>')) return false;
      return !ast.superClassName || trivial(ast.superClassName, seen) || !!(this.jvm.jre && this.jvm.jre[ast.superClassName]);
    };
    for (const name of wanted) {
      if (!trivial(name)) continue;
      if (this.jvm.classInitializationState.get(name) === 'INITIALIZED') continue;
      try {
        const pushed = await this.jvm.initializeClassIfNeeded(name, thread);
        if (pushed) throw new ClosedWorldError(`closed world: trivial class ${name} pushed an initializer`);
      } catch (error) {
        if (error instanceof ClosedWorldError) throw error;
      }
    }
  }

  // Load the classes admitted code may reference (without initializing them),
  // so admission sees every implementation and layout it needs.
  async loadReferencedClasses() {
    const jvm = this.jvm;
    const done = new Set();
    for (let round = 0; round < 64; round++) {
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
    const code = method.attributes?.find((a) => a.type === 'code')?.code;
    if (!code) return this.reject(key, 'no-code');
    const table = code.exceptionTable || [];
    let ranges = [];
    if (table.length) {
      try { ranges = resolveHandlerRanges(code.codeItems, table); } catch { return this.reject(key, 'handler-ranges'); }
      const end = (code.codeItems || []).length;
      for (const range of ranges) {
        if (range.startItemIdx === undefined || range.startItemIdx === null) return this.reject(key, 'handler-range-start');
        if (range.endItemIdx === undefined || range.endItemIdx === null) range.endItemIdx = end;
      }
    }
    for (const item of code.codeItems || []) {
      const op = typeof item.instruction === 'string' ? item.instruction : item.instruction?.op;
      if (REJECT_OPS.has(op)) return this.reject(key, `op:${op}`);
    }
    let fn;
    try {
      const covered = ranges.length ? (item) => ranges.some((r) => item >= r.startItemIdx && item < r.endItemIdx) : undefined;
      fn = buildSsa({ codeItems: code.codeItems, exceptionTable: table, method, className }, { slotDefsAt: covered });
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
      paramReprs: [...(isStatic ? [] : [this.reprOfClass(className)]), ...params.map((p) => this.reprOfDescriptor(p))],
      returnKind: kindOf(ret),
      returnRepr: this.reprOfDescriptor(ret),
      plan: new Map(),
      calls: new Set(),
      initClasses: new Set(),
      synchronized: flags.includes('synchronized'),
      handlerEntries: null,
      handlerBlocks: null,
    };
    if (table.length) {
      const end = (code.codeItems || []).length;
      record.handlerEntries = fn.handlerEntries.map((h) => (h.endItemIdx === undefined || h.endItemIdx === null ? Object.assign(h, { endItemIdx: end }) : h));
      record.handlerBlocks = new Map();
      for (const block of fn.blocks) {
        if (!block.isHandlerEntry) continue;
        for (const h of block.handlers) record.handlerBlocks.set(h, block.id);
      }
      if (record.handlerEntries.some((h) => !record.handlerBlocks.has(h))) return this.reject(key, 'handler-block');
    }
    if (record.synchronized && isStatic) {
      const mirror = this.jvm.getClassObjectSync?.(className);
      if (!mirror) return this.reject(key, 'synchronized-static-mirror');
      record.lockGlobal = this.globalImport(`k:${this.globalImports.size}`, [VT.externref], false, mirror);
    }
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
        if (!layout) {
          // JRE objects and other host-shaped storage: the interpreter's own
          // field handler, one import per site.
          plan.set(node.id, this.hostFieldPlan(op, imm, kindOf(descriptor)));
          return;
        }
        let declaring = owner, field = null;
        for (let current = owner; current && !field; current = this.classAst(current)?.superClassName) {
          field = layout.byKey.get(`${current}.${name}`) || null;
          declaring = current;
        }
        if (!field) throw new Unsupported(`field-unresolved: ${owner}.${name}`);
        const reference = field.index !== undefined;
        if (reference && !this.classTypes.has(declaring)) throw new Unsupported(`field-without-class-type: ${declaring}.${name}`);
        plan.set(node.id, {
          kind: op === 'getfield' ? 'field-get' : 'field-put', reference,
          index: field.index, offset: field.offset, slotKind: field.kind, valueKind: kindOf(descriptor), declaring,
          // Reference fields are fields of the declaring class's struct.
          structType: reference ? this.classTypes.get(declaring).key : null,
          structIndex: reference ? OBJ_FIELDS.length + field.index : null,
          fieldRepr: reference ? this.reprOfDescriptor(descriptor) : null,
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
        const valtype = cell.closedType === 'anyref' ? this.wasmType('A', this.reprOfDescriptor(descriptor)) : [WT[valueKind]];
        const global = this.staticGlobal(`s:${declaring}.${name}:${descriptor}`, valtype, cell);
        record.initClasses.add(declaring);
        plan.set(node.id, { kind: op === 'getstatic' ? 'static-get' : 'static-put', global, valueKind,
          initClass: this.initCheckFor(record, declaring) });
        return;
      }
      case 'invokestatic': case 'invokespecial': case 'invokevirtual': case 'invokeinterface':
        this.planInvoke(record, node);
        return;
      case 'new': {
        const className = imm;
        if (!this.jvm.classes[className] && !(this.jvm.jre && this.jvm.jre[className])) {
          // The interpreter throws NoClassDefFoundError when this executes.
          plan.set(node.id, { kind: 'import', argKinds: [], fn: this.throwingImport(`nocls:${className}`, [], [VT.anyref],
            'java/lang/NoClassDefFoundError', className) });
          return;
        }
        if (this.isGuestClass(className) && !this.runtime.layout(className)) throw new Unsupported(`new-without-layout: ${className}`);
        record.initClasses.add(className);
        const jit = this.jit;
        const fn = this.siteImport(`new:${className}`, [], [VT.anyref],
          () => this.runtime.toWasm(jit.allocateObject(className)));
        plan.set(node.id, { kind: 'import', fn, argKinds: [], initClass: this.initCheckFor(record, className) });
        return;
      }
      case 'newarray': {
        const atype = typeof imm === 'number' ? NEWARRAY[imm] : imm;
        const desc = { boolean: '[Z', byte: '[B', char: '[C', short: '[S', int: '[I', long: '[J', float: '[F', double: '[D' }[atype];
        const runtime = this.runtime;
        const fn = this.siteImport(`newarray:${atype}`, [VT.i32], [VT.anyref], (count) => runtime.newPrimitiveArray(desc, count));
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
      case 'monitorenter': case 'monitorexit': {
        const name = op === 'monitorenter' ? 'menter' : 'mexit';
        plan.set(node.id, { kind: 'import', fn: this.hostImport(name, [VT.anyref], []), argKinds: ['A'] });
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
      if (!target) {
        const missingClass = !this.jvm.classes[owner] && !(this.jvm.jre && this.jvm.jre[owner]);
        record.plan.set(node.id, { kind: 'import', argKinds, fn: this.throwingImport(`nomethod:${owner}.${name}${descriptor}`,
          argKinds.map((k) => WT[k]), returnKind === 'V' ? [] : [WT[returnKind]],
          missingClass ? 'java/lang/NoClassDefFoundError' : 'java/lang/NoSuchMethodError',
          missingClass ? owner : `${owner}.${name}${descriptor}`) });
        return;
      }
      if (op === 'invokestatic') record.initClasses.add(target.owner);
      const initClass = op === 'invokestatic' ? this.initCheckFor(record, target.owner) : null;
      if (target.native) {
        this.rejectAsyncNative(target.native, `${target.owner}.${name}${descriptor}`);
        const fn = this.nativeImport(`native:${target.owner}.${name}${descriptor}`, target.native, descriptor, op !== 'invokestatic');
        record.plan.set(node.id, { kind: 'import', fn, argKinds, initClass });
        return;
      }
      if (!this.isGuestClass(target.owner)) throw new Unsupported(`invoke-nonguest: ${target.owner}.${name}`);
      if (this.jspi && target.method && flagsOf(target.method).includes('native')) {
        // A guest native (JNI registry): the interpreter's invoke resolves it.
        const siteId = this.sites.push({ where, target: `${owner}.${name}${descriptor}`,
          invoke: { op, imm: node.imm, className: record.className, argKinds, returnKind } }) - 1;
        record.plan.set(node.id, { kind: 'import', fn: this.bytecodeInvokeImport(siteId), argKinds, initClass });
        return;
      }
      const calleeKey = `${target.owner}.${name}${descriptor}`;
      record.calls.add(calleeKey);
      record.plan.set(node.id, { kind: 'call', fn: `m:${calleeKey}`, argKinds, initClass,
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
        this.rejectAsyncNative(impl.native, `${impl.owner}.${name}${descriptor}`);
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
    const siteId = this.sites.push({ where, target: `${owner}.${name}${descriptor}`,
      invoke: { op, imm: node.imm, className: record.className, argKinds, returnKind } }) - 1;
    // With JSPI, a receiver the module has no code for (a class newer than
    // the module, a lambda, any host object without a native) runs this very
    // instruction in an ordinary frame while the caller is parked.
    const fallbackFn = this.jspi ? this.bytecodeInvokeImport(siteId) : null;
    let hostFn = null;
    if (hostCapable) {
      // The static owner's own native (if any) is what most host receivers run.
      for (let current = owner; current;) {
        const native = this.jvm._jreFindMethod?.(current, name, descriptor);
        if (native) { this.rejectAsyncNative(native, `${current}.${name}${descriptor}`); break; }
        current = this.jvm.jre?.[current]?.super || this.classAst(current)?.superClassName || null;
      }
      const world = this;
      const { resolveVirtualHost } = this;
      const { runtimeClassName } = (this.objectInstructions ||= require('../../instructions/object'));
      // Resolution depends only on the receiver's class.
      const byClass = new Map();
      hostFn = this.siteImport(`vhost:${owner}.${name}${descriptor}`, argKinds.map((k) => WT[k]),
        returnKind === 'V' ? [] : [WT[returnKind]], (...wasmArgs) => {
          const receiver = world.runtime.toJs(wasmArgs[0]);
          if (receiver === null || receiver === undefined) throw { type: 'java/lang/NullPointerException', message: null };
          const className = runtimeClassName(receiver);
          let native = byClass.get(className);
          if (native === undefined) {
            native = resolveVirtualHost.call(world, receiver, owner, name, descriptor);
            if (className !== undefined) byClass.set(className, native);
          }
          if (!native) {
            if (fallbackFn) return world.parkBytecodeInvoke(siteId, wasmArgs);
            throw new ClosedWorldError(`closed world: no host implementation of ${owner}.${name}${descriptor} for ${className}`);
          }
          const args = params.map((p, i) => world.toJsValue(kindOf(p), wasmArgs[i + 1]));
          const result = native(world.jvm, receiver, args, world.thread);
          return world.hostResult(returnKind, result, `${owner}.${name}${descriptor}`, descriptor.slice(descriptor.lastIndexOf(')') + 1));
        });
    }
    record.plan.set(node.id, {
      kind: 'virtual', argKinds, returnKind, siteId, hostFn, fallbackFn,
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
    if ((name === 'sin' || name === 'cos') && descriptor === '(D)D') {
      // fdlibm in Wasm (fdlibm.js), bit-identical to the JS builtin; huge
      // arguments still reach the builtin through the pure import.
      this.pureImport(`math:${name}`, [VT.f64], [VT.f64], Math[name]);
      (this.trigFunctions ||= new Set()).add(name);
      return { kind: 'call', fn: `fdlibm:${name}` };
    }
    const unary = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'log10', 'cbrt', 'sinh', 'cosh', 'tanh', 'expm1', 'log1p'];
    const binary = ['atan2', 'pow', 'hypot'];
    if (descriptor === '(D)D' && unary.includes(name)) {
      return { kind: 'import', fn: this.pureImport(`math:${name}`, [VT.f64], [VT.f64], Math[name]) };
    }
    if (descriptor === '(DD)D' && binary.includes(name)) {
      return { kind: 'import', fn: this.pureImport(`math:${name}`, [VT.f64, VT.f64], [VT.f64], Math[name]) };
    }
    return null;
  }

  resolveVirtualHost(receiver, owner, name, descriptor) {
    const { runtimeClassName } = (this.objectInstructions ||= require('../../instructions/object'));
    const className = runtimeClassName(receiver);
    let current = className || owner;
    while (current) {
      const native = this.jvm._jreFindMethod(current, name, descriptor);
      if (native) return native;
      const data = this.jvm.classes[current];
      current = this.jvm.jre?.[current]?.super || data?.ast?.classes?.[0]?.superClassName || null;
    }
    // java/lang/Object methods on strings and other host values.
    return this.jvm._jreFindMethod('java/lang/Object', name, descriptor) || null;
  }

  bytecodeInvokeImport(siteId) {
    const { argKinds, returnKind } = this.sites[siteId].invoke;
    const world = this;
    return this.siteImport(`vslow:${siteId}`, argKinds.map((k) => WT[k]), returnKind === 'V' ? [] : [WT[returnKind]],
      (...wasmArgs) => world.parkBytecodeInvoke(siteId, wasmArgs));
  }

  // Park, then run the site's own invoke instruction in a one-instruction
  // frame: the interpreter dispatches on the receiver exactly as it would
  // for any caller, and its result comes back to the parked module.
  parkBytecodeInvoke(siteId, wasmArgs) {
    const site = this.sites[siteId], { argKinds, returnKind } = site.invoke;
    const signature = site.invokeSignature ||= this.bytecodeInvokeSignature(site.invoke);
    const args = argKinds.map((k, i) => this.toJsValue(k, wasmArgs[i]));
    if (!this.requestPark({ invoke: signature, args, onStack: true })) {
      throw new ClosedWorldError(`closed world: no module code for ${site.target} at ${site.where} and this entry cannot park`);
    }
    return parkDummy(returnKind);
  }

  bytecodeInvokeSignature({ op, imm, className, argKinds, returnKind }) {
    const ret = { V: 'return', I: 'ireturn', J: 'lreturn', F: 'freturn', D: 'dreturn', A: 'areturn' }[returnKind];
    const method = {
      name: `<closed-invoke ${imm[2][0]}>`, descriptor: '()V', flags: ['static', 'synthetic'],
      attributes: [{ type: 'code', code: {
        localsSize: '0', stackSize: String(argKinds.length + 2),
        codeItems: [{ labelDef: 'L0:', instruction: { op, arg: imm } }, { labelDef: 'L1:', instruction: ret }],
        exceptionTable: [],
      } }],
    };
    return { key: method.name, className, method, isStatic: true, synthetic: true, paramKinds: argKinds, returnKind };
  }

  planTypeTest(record, node, isCast) {
    const target = node.imm;
    const siteId = this.sites.push({ where: this.where(record, node), target }) - 1;
    if (target === 'java/lang/Object') return { kind: isCast ? 'checkcast' : 'instanceof', always: true, siteId };
    if (/^\[[ZBCSIJFD]$/.test(target)) {
      return { kind: isCast ? 'checkcast' : 'instanceof', primitiveKind: require('./representation').KIND[target], siteId };
    }
    const jvm = this.jvm, runtime = this.runtime;
    const { runtimeClassName } = require('../../instructions/object');
    const hostFn = this.siteImport(`isa:${target}`, [VT.anyref], [VT.i32], (value) => {
      const object = runtime.toJs(value);
      return object !== null && object !== undefined && jvm.isInstanceOfSync(runtimeClassName(object), target) ? 1 : 0;
    });
    const plan = { kind: isCast ? 'checkcast' : 'instanceof', hostFn, siteId };
    if (this.isGuestClass(target)) {
      // A class target tests the receiver's struct type, which every later
      // subclass type extends; an interface target lists the implementing
      // classes loaded now. Either way a closed object of a class this
      // module never saw, or a guest object that is not closed storage (the
      // heap was spent), is answered by JS rather than taken as a miss.
      plan.knownClassLimit = this.knownClassLimit;
      const classType = this.classTypes.get(target);
      if (classType) return { ...plan, structType: classType.key };
      const classIds = this.subclassIds(target).map((c) => c.id);
      if (classIds.length <= 32) return { ...plan, classIds };
    }
    return plan;
  }

  // Class ids below the limit belong to guest classes loaded when the module
  // was built (or to JRE classes, which no guest type test accepts); a class
  // loaded later gets an id at or above it.
  computeKnownClassLimit() {
    for (const name of Object.keys(this.jvm.classes)) this.classId(name);
    const indices = this.jvm._classIndices;
    let limit = indices.size;
    for (const [name, id] of indices) {
      if (id < limit && name[0] !== '[' && !this.jvm.classes[name] && !(this.jvm.jre && this.jvm.jre[name])) limit = id;
    }
    return limit;
  }

  // An operation whose execution throws a linkage error, like the interpreter.
  throwingImport(key, params, results, type, message) {
    const tag = this.tag;
    return this.siteImport(key, params, results, () => { throw new WebAssembly.Exception(tag, [{ type, message }]); });
  }

  hostFieldPlan(op, imm, valueKind) {
    const handlers = (this.objectInstructions ||= require('../../instructions/object'));
    const handler = handlers[op], instruction = { op, arg: imm }, jvm = this.jvm, world = this;
    const items = [];
    const frame = { stack: { items, pop: () => items.pop(), push: (v) => { items.push(v); }, isEmpty: () => !items.length } };
    const key = `hostfield:${op}:${imm[1]}.${imm[2][0]}`;
    if (op === 'getfield') {
      return { kind: 'import', argKinds: ['A'], fn: this.siteImport(key, [VT.anyref], [WT[valueKind]], (object) => {
        items.length = 0;
        items.push(world.runtime.toJs(object));
        handler(frame, instruction, jvm);
        return world.fromJs(valueKind, items.pop());
      }) };
    }
    return { kind: 'import', argKinds: ['A', valueKind], fn: this.siteImport(key, [VT.anyref, WT[valueKind]], [], (object, value) => {
      items.length = 0;
      items.push(world.runtime.toJs(object), world.toJsValue(valueKind, value));
      handler(frame, instruction, jvm);
    }) };
  }

  // ---- lazy class initialization -----------------------------------------
  // A class needs a check at a site unless it is the method's own class or a
  // superclass of it: those are initialized (or initializing on this thread)
  // whenever the method runs.
  initCheckFor(record, className) {
    for (let current = record.className; current; current = this.classAst(current)?.superClassName) {
      if (current === className) return null;
    }
    return this.initTarget(className);
  }

  initTarget(className) {
    this.initTargets ||= new Map();
    let target = this.initTargets.get(className);
    if (!target) {
      const token = this.jvm.getClassInitializationToken(className);
      const address = token.wasmReadinessAddress?.(this.runtime.heap);
      target = { className, id: this.initTargets.size, address: Number.isInteger(address) ? address : null };
      this.initTargets.set(className, target);
    }
    return target;
  }

  initImport() {
    const world = this, jvm = this.jvm;
    return this.hostImport('init', [VT.i32], []);
  }

  initializeSync(id) {
    const target = [...this.initTargets.values()][id];
    if (this.jspi && this.needsScheduledInit(target.className) && this.requestPark({ init: target.className })) return;
    const ok = this.jvm.initializeClassSync(target.className, this.thread, (className) => this.runClinit(className));
    if (!ok) throw new ClosedWorldError(`closed world: cannot initialize ${target.className} without blocking`);
  }

  runClinit(className) {
    const record = this.entries.get(`${className}.<clinit>()V`);
    if (!record || !record.fn) throw new ClosedWorldError(`closed world: <clinit> of ${className} is not in the module`);
    // A nested synchronous entry: a JS frame now sits between it and any
    // suspendable stack, so nothing below may park.
    this.syncDepth++;
    try { record.fn(); } finally { this.syncDepth--; }
  }

  // The calling convention of `key`: its record when admitted, otherwise
  // (JSPI) the same signature derived from its descriptor, for a stub.
  signatureOf(key) {
    const record = this.entries.get(key);
    if (record || !this.jspi) return record || null;
    this.stubSignatures ||= new Map();
    if (this.stubSignatures.has(key)) return this.stubSignatures.get(key);
    let signature = null;
    const dot = key.indexOf('.'), paren = key.indexOf('(');
    const className = key.slice(0, dot), name = key.slice(dot + 1, paren), descriptor = key.slice(paren);
    const method = this.findDeclaredMethod(className, name, descriptor);
    if (method) {
      const { params, ret } = parseMethodDescriptor(descriptor);
      const isStatic = isStaticMethod(method);
      signature = {
        key, className, method, isStatic, stub: true,
        paramKinds: [...(isStatic ? [] : ['A']), ...params.map(kindOf)],
        paramReprs: [...(isStatic ? [] : [this.reprOfClass(className)]), ...params.map((p) => this.reprOfDescriptor(p))],
        returnKind: kindOf(ret),
        returnRepr: this.reprOfDescriptor(ret),
      };
    }
    this.stubSignatures.set(key, signature);
    return signature;
  }

  // A method outside the module, called from inside it: hand the arguments
  // over, park, and return what the callee's frame returned.
  slowCallStub(signature) {
    const code = [];
    for (let i = 0; i < signature.paramKinds.length; i++) code.push(OP.local_get, ...uleb(i));
    code.push(OP.call, { fn: this.slowCallImport(signature) }, OP.call, { fn: this.parkImport(signature.returnKind) });
    const type = signature.returnKind === 'A' ? this.typeOfRepr(signature.returnRepr) : null;
    if (type) code.push(...GC.ref_cast_null, { stype: type });
    return code;
  }

  slowCallImport(signature) {
    const world = this;
    return this.siteImport(`slow:${signature.key}`, signature.paramKinds.map((k) => WT[k]), [], (...wasmArgs) => {
      const args = signature.paramKinds.map((k, i) => world.toJsValue(k, wasmArgs[i]));
      if (!world.requestPark({ invoke: signature, args })) {
        throw new ClosedWorldError(`closed world: ${signature.key} runs outside the module and this entry cannot park`);
      }
    });
  }

  // Initialization the module cannot finish synchronously: a <clinit> that
  // is not in the module, or a class another thread is initializing.
  needsScheduledInit(className) {
    const jvm = this.jvm, thread = this.thread;
    for (let current = className; current; current = this.classAst(current)?.superClassName) {
      const state = jvm.classInitializationState.get(current);
      if (state === 'INITIALIZED') return false;
      if (state === 'INITIALIZING' && jvm.classInitializationOwners.get(current) !== thread?.id) return true;
      const classData = jvm.classes[current];
      if (classData && jvm.findStaticInitializer(classData) && !this.entries.get(`${current}.<clinit>()V`)?.fn) return true;
    }
    return false;
  }

  // Module frames are invisible to the scheduler's maxStackDepth check, so
  // methods on a call cycle count their own depth (a `depth` global) and
  // throw StackOverflowError past the limit; Wasm stack exhaustion is a trap
  // no Java handler can catch. Tarjan's SCCs over module calls (virtual
  // calls record every implementation); entries only shrink afterwards, so
  // this over-approximates.
  markRecursion() {
    const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
    let next = 0;
    const visit = (root) => {
      const work = [[root, root.calls.values()]];
      index.set(root.key, next); low.set(root.key, next); next++;
      stack.push(root); onStack.add(root.key);
      while (work.length) {
        const top = work[work.length - 1], [record, iterator] = top;
        const step = iterator.next();
        if (!step.done) {
          const callee = this.entries.get(step.value);
          if (!callee) continue;
          if (callee === record) record.recursive = true;
          if (!index.has(callee.key)) {
            index.set(callee.key, next); low.set(callee.key, next); next++;
            stack.push(callee); onStack.add(callee.key);
            work.push([callee, callee.calls.values()]);
          } else if (onStack.has(callee.key)) {
            low.set(record.key, Math.min(low.get(record.key), index.get(callee.key)));
          }
          continue;
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent.key, Math.min(low.get(parent.key), low.get(record.key)));
        }
        if (low.get(record.key) !== index.get(record.key)) continue;
        const component = [];
        for (let member; member !== record;) { member = stack.pop(); onStack.delete(member.key); component.push(member); }
        if (component.length > 1) for (const member of component) member.recursive = true;
      }
    };
    for (const record of this.entries.values()) {
      record.recursive = false;
    }
    for (const record of this.entries.values()) if (!index.has(record.key)) visit(record);
    this.counters.recursive = [...this.entries.values()].filter((r) => r.recursive).length;
  }

  // The module's depth counter at an entry from the scheduler: the thread's
  // interpreter frames (module frames below a parked entry are not counted).
  setDepth(value) { if (this.depthGlobal) this.depthGlobal.value = value; }
  getDepth() { return this.depthGlobal ? this.depthGlobal.value : 0; }

  // ---- module assembly ----------------------------------------------------
  assemble() {
    this.markRecursion();
    // Compile bodies first: they register the imports they need.
    const bodies = new Map();
    // Each pass can only remove entries, so this reaches a fixed point.
    for (let pass = 0; ; pass++) {
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
      for (const [key, record] of this.jspi ? [] : this.entries) {
        const missing = [...record.calls].find((callee) => !this.entries.has(callee));
        if (missing) {
          this.entries.delete(key);
          bodies.delete(key);
          this.rejected.set(key, `callee-not-admitted: ${missing}`);
          changed = true;
        }
      }
      if (!changed) break;
    }
    for (const key of [...bodies.keys()]) if (!this.entries.has(key)) bodies.delete(key);
    if (!this.entries.size) return;

    const builder = new ModuleBuilder();
    builder.addRecGroup('closed', closedTypes());
    const classTypes = [...this.classTypes.values()];
    builder.addRecGroup('classes', classTypes.map((t) => subType([t.parent ? t.parent.key : T_OBJ], structType([
      ...OBJ_FIELDS,
      ...t.layout.references.map((f) => ({ type: this.wasmType('A', this.reprOfDescriptor(f.descriptor)), mutable: true })),
    ]))));
    builder.addGlobal('emptyRefs', ref(T_REFS), false, [...GC.array_new_fixed, { type: T_REFS }, 0]);
    builder.addGlobal('park', [VT.i32], true, [OP.i32_const, 0]);
    builder.exportGlobal('park', 'park');
    builder.addGlobal('depth', [VT.i32], true, [OP.i32_const, 0]);
    builder.exportGlobal('depth', 'depth');
    builder.importMemory('c', 'mem', this.runtime.heap.memory.buffer.byteLength >>> 16);
    builder.importTag('t', 'jx', [[VT.anyref]], 'jx');
    const importObject = { c: { mem: this.runtime.heap.memory }, t: { jx: this.tag }, s: {}, f: {} };
    // Synchronized methods: their body is compiled separately and called by
    // a wrapper that holds the monitor and releases it on every exit.
    const stubs = new Map();
    if (this.jspi) {
      for (const record of this.entries.values()) {
        for (const callee of record.calls) {
          if (this.entries.has(callee) || stubs.has(callee)) continue;
          const signature = this.signatureOf(callee);
          if (!signature) throw new Error(`closed world: no method ${callee} for a stub`);
          stubs.set(callee, signature);
          this.slowCallImport(signature);
          this.parkImport(signature.returnKind);
        }
      }
      this.parkImport('V');
    }
    for (const record of this.entries.values()) {
      if (record.synchronized) {
        this.hostImport('menter', [VT.anyref], []);
        this.hostImport('mexit', [VT.anyref], []);
        if (this.jspi) this.parkImport('V');
      }
    }
    let globalIndex = 0;
    for (const [key, g] of this.globalImports) {
      const field = `g${globalIndex++}`;
      builder.importGlobal('s', field, g.valtype, g.mutable, key);
      importObject.s[field] = g.mutable ? g.value : new WebAssembly.Global({ value: 'externref', mutable: false }, g.value);
    }
    const { OP: O, HT: H, f32bytes: f32b, f64bytes: f64b } = require('./wasmBuilder');
    let staticIndex = 0;
    for (const [key, g] of this.staticGlobals || []) {
      const init = { [VT.i32]: [O.i32_const, 0], [VT.i64]: [O.i64_const, 0], [VT.f32]: [O.f32_const, ...f32b(0)],
        [VT.f64]: [O.f64_const, ...f64b(0)] }[g.valtype[0]] || [O.ref_null, H.none];
      builder.addGlobal(key, g.valtype, true, init);
      g.exportName = `s${staticIndex++}`;
      builder.exportGlobal(g.exportName, key);
    }
    let importIndex = 0;
    const countImports = process.env?.JVM_CLOSED_WORLD_STATS === 'imports';
    if (countImports) this.importCalls = new Map();
    for (const [key, imp] of this.imports) {
      const field = `f${importIndex++}`;
      builder.importFunction('f', field, imp.params.map((p) => [p]), imp.results.map((r) => [r]), key);
      const bound = imp.suspending ? new WebAssembly.Suspending(imp.impl)
        : imp.pure ? imp.impl : this.wrapHost(imp.impl, imp.params.length);
      if (countImports && !imp.suspending) {
        const calls = this.importCalls;
        calls.set(key, 0);
        importObject.f[field] = (...args) => { calls.set(key, calls.get(key) + 1); return bound(...args); };
      } else {
        importObject.f[field] = bound;
      }
    }
    for (const name of this.trigFunctions || []) {
      require('./fdlibm').defineTrig(builder, name, (which) => `math:${which}`);
    }
    // Per-class allocation and per-field access for the VM's JS side.
    for (const t of classTypes) {
      if (!this.isAbstract(t.name)) {
        builder.declareFunction(`alloc:${t.name}`, [[VT.i32]], [ref(t.key)]);
        builder.defineFunction(`alloc:${t.name}`, [], [OP.local_get, 0, OP.i32_const, ...sleb(t.layout.classId),
          OP.global_get, { global: 'emptyRefs' }, OP.ref_null, VT.externref,
          ...t.layout.references.flatMap(() => [OP.ref_null, 0x71]), ...GC.struct_new, { type: t.key }]);
        builder.exportFunction(`a${t.index}`, `alloc:${t.name}`);
      }
      t.layout.references.forEach((f, j) => {
        if (f.owner !== t.name) return;
        const index = OBJ_FIELDS.length + f.index, fieldType = this.typeOfRepr(this.reprOfDescriptor(f.descriptor));
        builder.declareFunction(`get:${f.key}`, [[VT.anyref]], [[VT.anyref]]);
        builder.defineFunction(`get:${f.key}`, [], [OP.local_get, 0, ...GC.ref_cast, { stype: t.key }, ...GC.struct_get, { type: t.key }, ...uleb(index)]);
        builder.exportFunction(`g${t.index}_${j}`, `get:${f.key}`);
        builder.declareFunction(`set:${f.key}`, [[VT.anyref], [VT.anyref]], []);
        builder.defineFunction(`set:${f.key}`, [], [OP.local_get, 0, ...GC.ref_cast, { stype: t.key }, OP.local_get, 1,
          ...(fieldType ? [...GC.ref_cast_null, { stype: fieldType }] : []), ...GC.struct_set, { type: t.key }, ...uleb(index)]);
        builder.exportFunction(`p${t.index}_${j}`, `set:${f.key}`);
      });
    }
    let exportIndex = 0;
    for (const [key, record] of this.entries) {
      record.exportName = `m${exportIndex++}`;
      const params = record.paramKinds.map((k, i) => this.wasmType(k, record.paramReprs[i]));
      const results = record.returnKind === 'V' ? [] : [this.wasmType(record.returnKind, record.returnRepr)];
      builder.declareFunction(`m:${key}`, params, results);
      if (record.synchronized) builder.declareFunction(`m:${key}$body`, params, results);
      builder.exportFunction(record.exportName, `m:${key}`);
    }
    for (const [key, signature] of stubs) {
      const params = signature.paramKinds.map((k, i) => this.wasmType(k, signature.paramReprs[i]));
      const results = signature.returnKind === 'V' ? [] : [this.wasmType(signature.returnKind, signature.returnRepr)];
      builder.declareFunction(`m:${key}`, params, results);
      builder.defineFunction(`m:${key}`, [], this.slowCallStub(signature));
    }
    this.counters.stubs = stubs.size;
    for (const [key, body] of bodies) {
      const record = this.entries.get(key);
      if (!record.synchronized) { builder.defineFunction(`m:${key}`, body.locals, body.code); continue; }
      builder.defineFunction(`m:${key}$body`, body.locals, body.code);
      builder.defineFunction(`m:${key}`, ...this.synchronizedWrapper(record, key));
    }
    const bytes = builder.build();
    this.moduleBytes = bytes.length;
    if (process.env.JVM_CLOSED_WORLD_DUMP) {
      require('fs').writeFileSync(process.env.JVM_CLOSED_WORLD_DUMP, bytes);
      require('fs').writeFileSync(`${process.env.JVM_CLOSED_WORLD_DUMP}.imports`, [...this.imports.keys()].map((k, i) => `${i}\t${k}`).join('\n'));
    }
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), importObject);
    this.instance = instance;
    this.parkFlag = instance.exports.park;
    this.depthGlobal = instance.exports.depth;
    for (const g of (this.staticGlobals || new Map()).values()) g.cell.rebind(instance.exports[g.exportName]);
    const alloc = new Map(), fields = new Map();
    for (const t of classTypes) {
      if (!this.isAbstract(t.name)) alloc.set(t.name, instance.exports[`a${t.index}`]);
      t.layout.references.forEach((f, j) => {
        if (f.owner === t.name) fields.set(f.key, { get: instance.exports[`g${t.index}_${j}`], set: instance.exports[`p${t.index}_${j}`] });
      });
    }
    this.runtime.installClassTypes({ alloc, fields });
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

  synchronizedWrapper(record, key) {
    const { OP, GC, uleb } = require('./wasmBuilder');
    const n = record.paramKinds.length;
    const lock = n, result = n + 1;
    const hasResult = record.returnKind !== 'V';
    const locals = [[VT.anyref], ...(hasResult ? [this.wasmType(record.returnKind, record.returnRepr)] : [])];
    const lockCode = record.isStatic ? [OP.global_get, { global: record.lockGlobal }, ...GC.any_convert_extern] : [OP.local_get, 0];
    const call = (name) => [OP.local_get, ...uleb(lock), OP.call, { fn: this.hostImport(name, [VT.anyref], []) }];
    // A contended entry parks the thread (see park()) before the body runs.
    const enter = this.jspi ? [...call('menter'), OP.global_get, { global: 'park' }, OP.if, 0x40,
      OP.call, { fn: this.parkImport('V') }, OP.end] : call('menter');
    const code = [...lockCode, OP.local_set, ...uleb(lock), ...enter,
      OP.try, ...(hasResult ? this.wasmType(record.returnKind, record.returnRepr) : [0x40])];
    for (let i = 0; i < n; i++) code.push(OP.local_get, ...uleb(i));
    code.push(OP.call, { fn: `m:${key}$body` }, OP.catch_all, ...call('mexit'), OP.rethrow, 0, OP.end);
    if (hasResult) code.push(OP.local_set, ...uleb(result));
    code.push(...call('mexit'));
    if (hasResult) code.push(OP.local_get, ...uleb(result));
    return [locals, code];
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

  // Classes initialize lazily at their sites inside the module, so every
  // admitted method is always ready.
  isReady(record) {
    return true;
  }

  isReadyByClosure(record) {
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
    // The depth counter keeps module recursion below the engine's limit;
    // this is the backstop when frames are larger than it allows for.
    if (error instanceof RangeError && /call stack/i.test(error.message)) {
      return { type: 'java/lang/StackOverflowError', message: null };
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
    this.syncDepth++;
    const depth = this.getDepth();
    this.setDepth(thread ? thread.callStack.size() : 0);
    try {
      return record.fn(...wasmArgs);
    } catch (error) {
      if (error instanceof WebAssembly.Exception && error.is(this.tag)) throw this.runtime.toJs(error.getArg(this.tag, 0));
      throw this.translateTrap(error);
    } finally {
      this.setDepth(depth);
      this.syncDepth--;
      this.thread = previous;
    }
  }

  // Scheduler entry: a frame at pc 0 of an admitted, ready method.
  tryRunFrame(frame, thread) {
    if (frame.closedPark) return this.resumeFrame(frame, thread);
    if (frame.pc !== 0 || this.debugging()) return null;
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
    if (this.jspi) return this.enterSuspendable(frame, thread, record, args);
    let result;
    try {
      result = this.invokeEntry(record, args, thread);
    } catch (error) {
      // An internal (non-Java) failure leaves the frame in place, so the
      // scheduler reports it against the method that was running.
      if (error instanceof Error) throw error;
      // Every handler inside the module already ran. Replace the callee frame
      // with a handler-less tombstone so the scheduler dispatches in the
      // caller at its invoke, exactly as for an unwinding interpreter frame.
      if (frame.initializingClassName) this.jvm.failClassInitialization(frame);
      thread.callStack.pop();
      this.throwThroughTombstone(record, thread, error);
    }
    if (frame.initializingClassName) this.jvm.completeClassInitialization(frame);
    thread.callStack.pop();
    this.deliverReturn(frame, thread, record.returnKind, result);
    return { handled: true, returned: true };
  }

  // Module frames cannot be stepped or hit breakpoints, so a debugging
  // session keeps new calls on the interpreted tiers.
  debugging() {
    const debug = this.jvm.debugManager;
    return !!debug && (debug.debugMode || debug.breakpoints?.size > 0);
  }

  // A scheduler entry on its own suspendable stack. The returned promise
  // settles when the thread parks (the entry frame stays on top, holding the
  // continuation) or when the method completes.
  enterSuspendable(frame, thread, record, args) {
    const fn = record.promising ||= WebAssembly.promising(record.fn);
    const tick = beginSegment(frame);
    // Entries nest on one thread: a frame the module waits for (a slow call,
    // a <clinit>) can itself enter the module.
    frame.closedOuterEntry = thread.closedEntryFrame;
    thread.closedEntryFrame = frame;
    this.thread = thread;
    this.sliceStart = now();
    this.counters.entries += 1;
    this.setDepth(thread.callStack.size());
    fn(...args).then(
      (result) => this.completeSuspendable(frame, thread, record, result),
      (error) => this.failSuspendable(frame, thread, record, error));
    return tick;
  }

  resumeFrame(frame, thread) {
    const resume = frame.closedPark, outcome = frame.closedResumeWith;
    frame.closedPark = null;
    frame.closedResumeWith = undefined;
    const tick = beginSegment(frame);
    this.thread = thread;
    this.sliceStart = now();
    resume(outcome);
    return tick;
  }

  // A popped entry frame's return value, delivered as the interpreter's
  // return does: to a pending Method.invoke, or to the frame's return parent.
  deliverReturn(frame, thread, kind, result) {
    const explicitParent = frame.jitGeneratedReturnParent;
    frame.jitGeneratedReturnParent = undefined;
    frame.jitGeneratedReturnType = undefined;
    const { isReflectiveTarget, completeReflectiveCall } = (this.control ||= require('../../instructions/control'));
    if (isReflectiveTarget(thread, frame)) {
      completeReflectiveCall(thread, kind === 'V' ? null : this.toJsValue(kind, result));
      return;
    }
    if (kind === 'V') return;
    const parent = explicitParent || (thread.callStack.isEmpty() ? null : thread.callStack.peek());
    if (parent) parent.stack.push(this.toJsValue(kind, result));
  }

  completeSuspendable(frame, thread, record, result) {
    thread.closedEntryFrame = frame.closedOuterEntry;
    frame.closedOuterEntry = undefined;
    if (frame.initializingClassName) this.jvm.completeClassInitialization(frame);
    thread.callStack.pop();
    this.deliverReturn(frame, thread, record.returnKind, result);
    endSegment(frame, RETURNED);
  }

  failSuspendable(frame, thread, record, error) {
    thread.closedEntryFrame = frame.closedOuterEntry;
    frame.closedOuterEntry = undefined;
    const tick = frame.closedTick;
    frame.closedTick = null;
    let thrown = error;
    if (error instanceof WebAssembly.Exception && error.is(this.tag)) thrown = this.runtime.toJs(error.getArg(this.tag, 0));
    else thrown = this.translateTrap(error);
    if (thrown instanceof Error) { tick.reject(thrown); return; }
    if (frame.initializingClassName) this.jvm.failClassInitialization(frame);
    thread.callStack.pop();
    try { this.throwThroughTombstone(record, thread, thrown); } catch (e) { tick.reject(e); }
  }

  // Synchronous call from generated JS code: consumes the operands.
  tryInvoke(method, frame, thread) {
    // A JS caller's frame would sit between the module and any suspension,
    // so with JSPI the callee runs as its own scheduler frame instead.
    if (this.jspi || this.debugging()) return NOT_CLOSED;
    const record = this.entryByMethod.get(method);
    if (!record || !this.isReady(record)) return NOT_CLOSED;
    const items = frame.stack.items;
    const count = record.paramKinds.length;
    const base = items.length - count;
    if (base < 0) return NOT_CLOSED;
    const args = new Array(count);
    for (let i = 0; i < count; i++) args[i] = this.fromJs(record.paramKinds[i], items[base + i]);
    items.length = base;
    let result;
    try {
      result = this.invokeEntry(record, args, thread);
    } catch (error) {
      // The generated caller materialized its post-invoke pc; a tombstone
      // callee frame makes propagation use that pc - 1, the invoke itself.
      this.throwThroughTombstone(record, thread, error);
    }
    return record.returnKind === 'V' ? undefined : this.toJsValue(record.returnKind, result);
  }

  throwThroughTombstone(record, thread, error) {
    if (error instanceof Error) throw error;
    const Frame = (this.Frame ||= require('../../core/frame'));
    const tombstone = new Frame(record.method);
    tombstone.className = record.className;
    tombstone.exceptionTable = [];
    thread.callStack.push(tombstone);
    throw error;
  }
}

const NOT_CLOSED = Symbol('closed.not-closed');
const PARKED = Object.freeze({ handled: true });
const RETURNED = Object.freeze({ handled: true, returned: true });

function jspiAvailable() {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.Suspending !== 'function' ||
      typeof WebAssembly.promising !== 'function') return false;
  const env = typeof process !== 'undefined' ? process.env : null;
  return env?.JVM_CLOSED_WORLD_JSPI !== '0';
}

function parkDummy(kind) {
  switch (kind) {
    case 'J': return 0n;
    case 'A': return null;
    case 'V': return undefined;
    default: return 0;
  }
}

function beginSegment(frame) {
  return new Promise((resolve, reject) => { frame.closedTick = { resolve, reject }; });
}

function endSegment(frame, value) {
  const tick = frame.closedTick;
  frame.closedTick = null;
  tick.resolve(value);
}

module.exports = { ClosedWorld, ClosedWorldError, NOT_CLOSED, parseMethodDescriptor, kindOf, jspiAvailable };
