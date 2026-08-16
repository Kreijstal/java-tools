'use strict';

// Closed-world class hierarchy over the classes currently registered in
// jvm.classes. The world grows as classes load: jvm.classEpoch increments on
// every registration and refresh() rebuilds lazily. Facts derived here are
// complete only for the loaded world, so consumers must pair them with a safe
// dynamic fallback for receivers whose class loads later (the wasm dispatch
// import deopts to the interpreter on a map miss).

class ClassHierarchy {
  constructor(jvm) {
    this.jvm = jvm;
    this.epoch = -1;
    this.subclasses = null; // className -> Set(direct subclasses/implementors)
    this.dispatchMemo = null;
  }

  refresh() {
    const epoch = this.jvm.classEpoch || 0;
    if (this.epoch === epoch && this.subclasses) return;
    this.epoch = epoch;
    this.subclasses = new Map();
    this.dispatchMemo = new Map();
    for (const [name, cd] of Object.entries(this.jvm.classes)) {
      const cls = cd && cd.ast && cd.ast.classes && cd.ast.classes[0];
      if (!cls) continue;
      const link = (parent) => {
        if (!parent || parent === name) return;
        let set = this.subclasses.get(parent);
        if (!set) this.subclasses.set(parent, (set = new Set()));
        set.add(name);
      };
      link(cls.superClassName);
      for (const itf of cls.interfaces || []) link(itf);
    }
  }

  _classAst(name) {
    const cd = this.jvm.classes[name];
    if (!cd || cd.isJreStub || !cd.ast || !cd.ast.classes) return null;
    return cd.ast.classes[0] || null;
  }

  // First (name, descriptor) match walking up the superclass chain from
  // className. null when unresolved, abstract, or when the walk crosses an
  // unloaded/stub class — a stub could hide an override, so nothing past it
  // can be trusted.
  findImplementation(className, name, descriptor) {
    let current = className;
    for (let depth = 0; current && depth < 64; depth += 1) {
      const cls = this._classAst(current);
      if (!cls) return null;
      const method = (cls.items || [])
        .filter((i) => i.type === 'method').map((i) => i.method)
        .find((m) => m.name === name && m.descriptor === descriptor);
      if (method) {
        if ((method.flags || []).includes('abstract')) return null;
        return { className: current, method };
      }
      if (current === 'java/lang/Object') return null;
      current = cls.superClassName;
    }
    return null;
  }

  // Complete dispatch table for a virtual/interface call on `owner` over the
  // loaded world: { targets: Map<concrete runtime class, impl>, impls:
  // Map<implKey, impl>, complete, noHiddenReceivers }. Concrete cone members
  // whose resolution is stub-tainted are silently absent from targets — their
  // instances take the caller's runtime fallback path — and clear `complete`,
  // which consumers that guard by instanceof (not by exact runtime class) must
  // require. `noHiddenReceivers` is the weaker fact such consumers can also
  // accept: completeness was lost only to cone members that are not loaded at
  // all, so no instance of them exists to slip past a guard today.
  resolveDispatch(owner, name, descriptor) {
    this.refresh();
    const memoKey = `${owner}.${name}${descriptor}`;
    if (this.dispatchMemo.has(memoKey)) return this.dispatchMemo.get(memoKey);
    const result = this._resolveDispatch(owner, name, descriptor);
    this.dispatchMemo.set(memoKey, result);
    return result;
  }

  _resolveDispatch(owner, name, descriptor) {
    // An unloaded owner is not a reason to give up. Nothing forces an interface
    // class to load — invokeinterface resolves through the receiver — so the
    // declared owner of a hot interface call is routinely absent while its
    // implementors are present. `subclasses` is keyed by name and is built from
    // the implementors' own `interfaces` lists, so the cone is still
    // discoverable. The owner itself then drops out below as an unloaded member
    // and clears `complete`, which is what the consumers that need a closed
    // world already test; consumers that key on the exact runtime class stay
    // correct because a receiver missing from the map deopts to the interpreter.
    const seen = new Set([owner]);
    const queue = [owner];
    const cone = [];
    while (queue.length) {
      const cur = queue.pop();
      cone.push(cur);
      for (const sub of this.subclasses.get(cur) || []) {
        if (!seen.has(sub)) { seen.add(sub); queue.push(sub); }
      }
    }
    const targets = new Map();
    const impls = new Map();
    let complete = true;
    // Why completeness was lost matters. A cone member that is not in
    // jvm.classes at all cannot currently have an instance, so it hides no
    // receiver from an instanceof guard — the routine case is the declared
    // owner of an interface call, which nothing forces to load. A member that
    // IS registered but unusable here (a JRE stub, or a class whose own
    // resolution failed) can have instances, and one of them could reach a
    // guard for a supertype whose body it overrides. Only the second kind
    // makes guard-based specialization unsound.
    let hiddenReceivers = false;
    for (const member of cone) {
      const cls = this._classAst(member);
      if (!cls) {
        complete = false;
        if (this.jvm.classes[member]) hiddenReceivers = true;
        continue;
      }
      const flags = cls.flags || [];
      if (flags.includes('abstract') || flags.includes('interface')) continue;
      const impl = this.findImplementation(member, name, descriptor);
      if (!impl) { complete = false; hiddenReceivers = true; continue; }
      targets.set(member, impl);
      impls.set(`${impl.className}.${name}${descriptor}`, impl);
    }
    if (!targets.size) return null;
    return { targets, impls, complete, noHiddenReceivers: !hiddenReceivers };
  }

  // invokespecial (non-<init>) is statically bound. Resolution walks up from
  // the named owner; private targets must live in the calling class itself,
  // and non-private targets are only trusted for same-class calls or the
  // ACC_SUPER shape where the owner is the caller's direct superclass (there
  // the walk from the owner equals the JVMS re-resolution from the caller's
  // superclass).
  resolveSpecial(callerClass, owner, name, descriptor) {
    this.refresh();
    const impl = this.findImplementation(owner, name, descriptor);
    if (!impl) return null;
    if ((impl.method.flags || []).includes('private')) {
      return impl.className === callerClass && owner === callerClass ? impl : null;
    }
    if (owner === callerClass) return impl;
    const caller = this._classAst(callerClass);
    if (caller && caller.superClassName === owner) return impl;
    return null;
  }

  // Constructors are never inherited: invokespecial <init> binds to exactly
  // the named owner's own constructor, from any caller, so resolution is an
  // exact lookup with no superclass walk and no caller-shape restriction.
  resolveInit(owner, descriptor) {
    this.refresh();
    const cls = this._classAst(owner);
    if (!cls) return null;
    const method = (cls.items || [])
      .filter((i) => i.type === 'method').map((i) => i.method)
      .find((m) => m.name === '<init>' && m.descriptor === descriptor);
    return method ? { className: owner, method } : null;
  }
}

module.exports = { ClassHierarchy };
