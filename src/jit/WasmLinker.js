'use strict';

// Runtime linker for the Wasm tier (docs/refactor.md 1.6, docs/phase1-linked-
// call-abi.md 3): "codegen states the dependency; resolving it is the
// runtime's job."
//
// A caller lowered while its static callee owned no module used to bake a
// JS trampoline (`lcall_`) into its import object for good: once the callee
// compiled, every call still crossed into JS, resolved the callee's state and
// entered it through the nested-call bridge, until somebody recompiled the
// caller (off by default -- it storms). The linker replaces that permanent
// bridge with a funcref TABLE SLOT per late-bound call site:
//
//   caller module:  args..., i32.const <slot>, call_indirect <sig> (table 0)
//   table[slot]  :  stub  -> the JS trampoline, wrapped as a wasm function
//                   runv  -> the callee's own direct-link export
//
// Binding is a table write, never a caller recompile. When a callee becomes
// ready and satisfies the direct-link contract (fully compiled, never exits,
// identity slot mapping, unboxed, no EH, not speculative) the linker points
// every slot naming it at the callee's `runv` export, and the call becomes
// wasm->wasm with no JS on the path. When that callee's module is reset (a
// dependency-world or speculation recompile) the slot goes back to the stub,
// which resolves the callee's CURRENT state per call exactly as the old
// trampoline did -- so a caller is never left holding a funcref to a module
// the runtime has withdrawn, and a partial callee (one that may hand the call
// back mid-body) always runs under the nested-call protocol behind the stub.
//
// The call site keeps both halves of the existing protocols: it checks the
// status word the `runv` shape returns (never-exits invariant, traps
// otherwise) AND the deopt flag the trampoline shape sets, so either occupant
// of the slot is sound. Which one is in the slot at any moment is this
// module's state, readable through slotState() for tests and censuses.
//
// Not owned here, deliberately: the pending-link registry (which callers wait
// on which callee) stays in WasmJit; the linker only answers "what does the
// table say for this callee right now".
const {
  T, OP, uleb, sleb, descToWasm, parseMethodDescriptor, sealedNeverExits,
  hasUncheckedSpeculation,
} = require('./wasmShared');

const OP_CALL_INDIRECT = 0x11;

class WasmLinker {
  constructor(wasmJit) {
    this.wasmJit = wasmJit;
    this.enabled = typeof WebAssembly !== 'undefined' &&
      typeof WebAssembly.Table === 'function';
    // One shared table; every caller module imports it as env.ltab with a
    // zero minimum, so growth here never invalidates an existing instance.
    this.table = this.enabled
      ? new WebAssembly.Table({ element: 'anyfunc', initial: 0 }) : null;
    this.slots = []; // index -> slot record
    this.slotsByCallee = new Map(); // callee key -> [slot]
    // Indices whose module was never installed (a discarded translation);
    // reused before the table grows.
    this.freeSlots = [];
    // Stub MODULES are per signature (the wasm bytes depend only on the
    // types); stub INSTANCES are per slot (each imports its own trampoline).
    this.stubModules = new Map();
    this.stats = { slots: 0, bound: 0, unbound: 0, stubbed: 0, sealed: 0, pinned: 0 };
  }

  // Wasm signature of a slot: the runv shape, [params] -> [status, ret?].
  static slotSignature(descriptor) {
    const { params, ret } = parseMethodDescriptor(descriptor);
    const wParams = params.map(descToWasm);
    const wResults = ret === 'V' ? [T.i32] : [T.i32, descToWasm(ret)];
    return { params: wParams, results: wResults, ret };
  }

  // Reserve a table slot for one late-bound call site. `trampoline` is the
  // site's JS closure with the plain [params] -> [ret?] shape (it signals
  // deopt through the caller's box, as before); it is wrapped into a wasm
  // function returning status -1 so the slot has one funcref type whichever
  // occupant it holds. Returns the slot index the caller bakes into its
  // call_indirect.
  allocate({ key, className, name, descriptor, trampoline }) {
    if (!this.enabled) throw new Error('WasmLinker: no WebAssembly.Table');
    const signature = WasmLinker.slotSignature(descriptor);
    const index = this.freeSlots.length ? this.freeSlots.pop() : this.slots.length;
    const slot = {
      index, key, className, name, descriptor, signature, stub: null,
      occupant: 'stub', boundTo: null,
      // Calls that reached the JS trampoline; a sealed group's slots must
      // stop moving this (test/wasmRecursiveGroup.test.js).
      stubCalls: 0,
      // Set by sealGroups: this slot is an edge of a never-exits recursive
      // group and keeps its export across the callee's withdrawal.
      sealed: false,
    };
    slot.stub = this.stubFor(signature, (...args) => {
      slot.stubCalls += 1;
      return trampoline(...args);
    });
    if (this.table.length <= index) {
      this.table.grow(Math.max(16, index + 1 - this.table.length));
    }
    this.table.set(index, slot.stub);
    this.slots[index] = slot;
    let list = this.slotsByCallee.get(key);
    if (!list) {
      list = [];
      this.slotsByCallee.set(key, list);
    }
    list.push(slot);
    this.stats.slots += 1;
    return index;
  }

  // A tiny module: (import "env" "f" (func params -> ret?)) and one exported
  // function of the slot's signature that forwards to it and reports status
  // -1 ("completed") -- the trampoline's deopt path sets the caller's flag,
  // which the call site reads right after the call.
  stubFor(signature, trampoline) {
    const key = `${signature.params.join(',')}|${signature.results.join(',')}`;
    let module = this.stubModules.get(key);
    if (!module) {
      const importResults = signature.results.slice(1);
      const type = (p, r) => [0x60, ...uleb(p.length), ...p, ...uleb(r.length), ...r];
      const types = [type(signature.params, importResults),
        type(signature.params, signature.results)];
      const name = (s) => [...s].map((c) => c.charCodeAt(0));
      const importEntry = [...uleb(3), ...name('env'), ...uleb(1), ...name('f'), 0x00, 0x00];
      const exportEntry = [...uleb(1), ...name('t'), 0x00, 0x01];
      const body = [0x00]; // no locals
      if (importResults.length) body.push(OP.i32_const, ...sleb(-1));
      for (let i = 0; i < signature.params.length; i++) body.push(OP.local_get, ...uleb(i));
      body.push(OP.call, 0x00);
      if (!importResults.length) body.push(OP.i32_const, ...sleb(-1));
      body.push(OP.end);
      const section = (id, content) => [id, ...uleb(content.length), ...content];
      const bytes = Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        ...section(1, [2, ...types.flat()]),
        ...section(2, [1, ...importEntry]),
        ...section(3, [1, 0x01]),
        ...section(7, [1, ...exportEntry]),
        ...section(10, [1, ...uleb(body.length), ...body]),
      ]);
      module = new WebAssembly.Module(bytes);
      this.stubModules.set(key, module);
    }
    const instance = new WebAssembly.Instance(module, { env: { f: trampoline } });
    return instance.exports.t;
  }

  // Can this callee state be entered straight from wasm through its runv
  // export? Mirrors the dcall_ eligibility in StructuredWasmCompiler
  // exactly: the two must not disagree about the same artifact.
  static directLinkable(st, descriptor) {
    const meta = WasmLinker.exportMeta(st);
    if (!meta) return false;
    if (meta.deoptableCalls && !sealedNeverExits(meta)) return false;
    return WasmLinker.identityParams(meta, descriptor);
  }

  // The direct-link contract minus the two parts that depend on where the
  // call comes from: the never-exits verdict (deoptableCalls) and the
  // argument layout (descriptor). Null when the state cannot be entered
  // through runv at all.
  static exportMeta(st) {
    if (!st || st.status !== 'ready') return null;
    const mod = st.callee || st;
    const meta = mod && mod.meta;
    if (!meta || !meta.runv) return null;
    if (!meta.fullyCompiled || meta.boxedCount || meta.usedEh) return null;
    if (hasUncheckedSpeculation(meta)) return null;
    if (st.synchronized || st.linkVetoed) return null;
    return meta;
  }

  static identityParams(meta, descriptor) {
    const { params } = parseMethodDescriptor(descriptor);
    if (meta.paramSlots.length !== params.length) return false;
    let slot = 0;
    for (let i = 0; i < params.length; i++) {
      const p = meta.paramSlots[i];
      if (p.slot !== slot || p.t !== descToWasm(params[i])) return false;
      slot += (params[i] === 'J' || params[i] === 'D') ? 2 : 1;
    }
    return true;
  }

  // A module that would satisfy the direct-link contract if its late-bound
  // slot sites could not deopt: every deoptable site it has is a slot site.
  // Whether they can deopt is what sealGroups decides, over the whole group.
  static sealable(st) {
    const meta = WasmLinker.exportMeta(st);
    if (!meta || meta.groupSealed) return false;
    if (!meta.linkSlots || !meta.linkSlots.length) return false;
    return meta.slotSites > 0 && meta.deoptableCalls === meta.slotSites;
  }

  // A callee's module was (re)published: point every slot naming it at the
  // new export when the direct contract holds, otherwise at the stub. The
  // stub resolves the callee's current state per call, so a partial or
  // speculative callee is still reached -- through the nested-call protocol
  // rather than a raw funcref. Returns how many slots now hold the export.
  bind(st) {
    if (!this.enabled || !st || !st.key) return 0;
    let direct = this.bindSlots(st);
    // A publication can complete a recursive group: this method may be the
    // last member whose module was missing, or the callee that turns a
    // member's last stub into an export. Members sealed here become
    // never-exits modules, so the slots naming THEM bind too.
    for (const member of this.sealGroups()) {
      const bound = this.bindSlots(member);
      if (member === st) direct = bound;
    }
    return direct;
  }

  bindSlots(st) {
    const list = this.slotsByCallee.get(st.key);
    if (!list) return 0;
    let direct = 0;
    // Same policy switch as the dcall_ import: with direct static links off,
    // every slot keeps its stub and the nested-call protocol.
    const allowDirect = this.wasmJit.directStaticLinkEnabled !== false;
    for (const slot of list) {
      if (allowDirect && WasmLinker.directLinkable(st, slot.descriptor)) {
        const runv = (st.callee || st).meta.runv;
        if (slot.boundTo !== runv) {
          this.table.set(slot.index, runv);
          slot.boundTo = runv;
          slot.occupant = 'direct';
          this.stats.bound += 1;
        }
        direct += 1;
      } else if (slot.sealed) {
        // The callee republished as something the contract refuses (a
        // partial recompile, say). A sealed edge keeps the never-exits
        // export it was sealed with -- the same "correct, possibly stale"
        // pin a dcall_ import keeps -- because its caller may already be
        // entered by others as a never-exits module.
        direct += 1;
      } else {
        this.stub(slot);
      }
    }
    return direct;
  }

  // docs/phase1-linked-call-abi.md 6, "recursive group": two methods that
  // call each other can never satisfy the never-exits contract one at a
  // time. Each one's only exit is the late-bound site naming the other, and
  // that site can deopt exactly as long as its slot may hold the stub. So
  // the verdict has to be taken over the group: find the largest set of
  // sealable modules (all their deoptable sites are slot sites) whose every
  // slot names either a plain never-exits export or another member, then
  // bind every one of those slots before any of them is called never-exits.
  // After the seal no slot in the group can deopt, and the deopt checks the
  // members carry behind those sites are dead code.
  //
  // A sealed slot never goes back to the stub: unbind() pins it (a withdrawn
  // callee's export is still a correct compilation of its bytecode, and the
  // stub would reintroduce a deopt path into a module others enter directly)
  // and bindSlots() moves it to the callee's new export when one qualifies.
  // Returns the states sealed by this call, in no particular order.
  sealGroups() {
    if (!this.enabled || this.wasmJit.directStaticLinkEnabled === false) return [];
    const states = this.wasmJit.stateByKey;
    if (!states) return [];
    const candidates = new Map();
    for (const [key, st] of states) {
      if (WasmLinker.sealable(st)) candidates.set(key, st);
    }
    if (!candidates.size) return [];
    // Greatest fixpoint: drop every candidate with a slot that cannot be
    // sealed, until nothing changes.
    let changed = true;
    while (changed && candidates.size) {
      changed = false;
      for (const [key, st] of candidates) {
        const meta = (st.callee || st).meta;
        let ok = true;
        for (const index of meta.linkSlots) {
          const slot = this.slots[index];
          if (!slot) { ok = false; break; }
          if (slot.occupant === 'direct') continue; // a never-exits export already
          const member = candidates.get(slot.key);
          if (member) {
            if (WasmLinker.identityParams((member.callee || member).meta, slot.descriptor)) continue;
            ok = false; break;
          }
          const callee = states.get(slot.key);
          if (callee && WasmLinker.directLinkable(callee, slot.descriptor)) continue;
          ok = false; break;
        }
        if (!ok) {
          candidates.delete(key);
          changed = true;
        }
      }
    }
    const sealed = [];
    for (const st of candidates.values()) {
      const meta = (st.callee || st).meta;
      for (const index of meta.linkSlots) {
        const slot = this.slots[index];
        slot.sealed = true;
        if (slot.occupant === 'direct') continue;
        const callee = candidates.get(slot.key) || states.get(slot.key);
        const runv = (callee.callee || callee).meta.runv;
        this.table.set(slot.index, runv);
        slot.boundTo = runv;
        slot.occupant = 'direct';
        this.stats.bound += 1;
      }
      meta.groupSealed = true;
      this.stats.sealed += 1;
      sealed.push(st);
    }
    return sealed;
  }

  // The callee's module was withdrawn (dependency-world or speculation
  // recompile): callers must stop entering it directly. Idempotent.
  unbind(key) {
    if (!this.enabled) return 0;
    const list = this.slotsByCallee.get(key);
    if (!list) return 0;
    let changed = 0;
    for (const slot of list) {
      if (slot.occupant === 'stub') continue;
      if (slot.sealed) {
        // See sealGroups: the export stays, the slot is marked so a census
        // can tell a pinned edge from a live one.
        if (slot.occupant !== 'pinned') {
          slot.occupant = 'pinned';
          this.stats.pinned += 1;
        }
        continue;
      }
      this.stub(slot);
      changed += 1;
    }
    this.stats.unbound += changed;
    return changed;
  }

  // A translation that allocated slots was discarded before installation
  // (the compiler re-lowered without inlining, the other backend won, or
  // the compile failed): give the indices back. The module that named them
  // never instantiated, so nothing can call through them.
  release(indices) {
    if (!this.enabled || !indices || !indices.length) return;
    for (const index of indices) {
      const slot = this.slots[index];
      if (!slot) continue;
      const list = this.slotsByCallee.get(slot.key);
      if (list) {
        const at = list.indexOf(slot);
        if (at >= 0) list.splice(at, 1);
        if (!list.length) this.slotsByCallee.delete(slot.key);
      }
      this.table.set(index, null);
      this.slots[index] = null;
      this.freeSlots.push(index);
      this.stats.slots -= 1;
    }
  }

  stub(slot) {
    if (slot.occupant === 'stub' || slot.sealed) return;
    this.table.set(slot.index, slot.stub);
    slot.boundTo = null;
    slot.occupant = 'stub';
    this.stats.stubbed += 1;
  }

  // 'direct' | 'pinned' | 'stub' per slot naming the callee; [] when nothing
  // waits on it. 'pinned' is a sealed edge whose callee was withdrawn.
  slotState(key) {
    return (this.slotsByCallee.get(key) || []).map((slot) => slot.occupant);
  }

  census() {
    let direct = 0;
    let pinned = 0;
    let live = 0;
    for (const slot of this.slots) {
      if (!slot) continue;
      live += 1;
      if (slot.occupant === 'direct') direct += 1;
      else if (slot.occupant === 'pinned') pinned += 1;
    }
    return { ...this.stats, direct, pinnedNow: pinned, stub: live - direct - pinned };
  }
}

WasmLinker.OP_CALL_INDIRECT = OP_CALL_INDIRECT;

module.exports = WasmLinker;
