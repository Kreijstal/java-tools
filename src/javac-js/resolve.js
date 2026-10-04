'use strict';

// Name lookup and method resolution (JLS 6.5, 15.12) plus a pragmatic
// implementation of generic method type inference (JLS 18). The compiler
// only has to handle valid programs, so applicability is decided on erased
// types and inference aims at the precision needed for member lookup,
// lambda parameter types and cast insertion.

const { F } = require('./flags');
const T = require('./types');

class Resolve {
  constructor(compiler) {
    this.c = compiler;
    this.syms = compiler.syms;
    this.types = compiler.syms.types;
    this.enter = compiler.enter;
    this.fnCache = new Map();
  }

  // ---- fields ----------------------------------------------------------------
  findField(csym, name) {
    const seen = new Set();
    const HIDDEN = {};
    const go = (s, top) => {
      if (!s || seen.has(s)) return null;
      seen.add(s);
      this.syms.completeMembers(s);
      for (const m of s.getMembers(name)) {
        if (m.kind === 'var') return (!top && (m.flags & F.PRIVATE)) ? HIDDEN : m;
      }
      if (s.superclass && s.superclass.kind === 'class') {
        const r = go(s.superclass.sym, false);
        if (r && r !== HIDDEN) return r;
      }
      for (const i of s.interfaces || []) {
        if (i.kind !== 'class') continue;
        const r = go(i.sym, false);
        if (r && r !== HIDDEN) return r;
      }
      return null;
    };
    const r = go(csym, true);
    return r === HIDDEN ? null : r;
  }

  // class symbol for member lookup in a type
  siteClass(site) {
    switch (site.kind) {
      case 'union': return this.siteClass(site.lub || this.syms.objectType);
      case 'class': return site.sym;
      case 'tvar': return this.siteClass(site.upperBound() || this.syms.objectType);
      case 'intersection': return this.siteClass(site.bounds[0]);
      case 'array': return null;
      default: return null;
    }
  }

  findFieldInType(site, name) {
    if (site.kind === 'union') return this.findFieldInType(site.lub || this.syms.objectType, name);
    if (site.kind === 'intersection') {
      for (const b of site.bounds) {
        const c = this.siteClass(b);
        const f = c && this.findField(c, name);
        if (f) return f;
      }
      return null;
    }
    if (site.kind === 'tvar') {
      for (const b of site.bounds || [this.syms.objectType]) {
        const f = this.findFieldInType(b, name);
        if (f) return f;
      }
      return null;
    }
    const c = this.siteClass(site);
    return c ? this.findField(c, name) : null;
  }

  // Find a variable by simple name: locals, fields of enclosing classes, static imports.
  findVar(name, env) {
    let crossedClass = false;
    for (let e = env; e; e = e.outer) {
      if (e.scope && e.scope.has(name)) {
        return { sym: e.scope.get(name), kind: 'local' };
      }
      if (e.kind === 'class' && e.clazz) {
        const f = this.findField(e.clazz, name);
        if (f) return { sym: f, kind: 'field', envClass: e.clazz, outer: crossedClass, env: e };
        crossedClass = true;
      }
      if (e.kind === 'unit') {
        const u = e.unit;
        for (const si of u.staticSingle) {
          if (si.name !== name) continue;
          const owner = this.syms.findClassByName(si.owner);
          if (!owner) continue;
          const f = this.findField(owner, name);
          if (f && (f.flags & F.STATIC)) return { sym: f, kind: 'field', staticImport: true };
        }
        for (const q of u.staticOnDemand) {
          const owner = this.syms.findClassByName(q);
          if (!owner) continue;
          const f = this.findField(owner, name);
          if (f && (f.flags & F.STATIC)) return { sym: f, kind: 'field', staticImport: true };
        }
      }
    }
    return null;
  }

  // ---- methods ---------------------------------------------------------------
  // All member methods named `name` visible in class csym, with overridden
  // ones removed. Signatures are compared as members of csym (so a generic
  // method overridden in a parameterized subtype counts as overridden), and
  // private methods of supertypes are not inherited.
  collectMethods(csym, name) {
    const out = [];
    const seenSigs = new Map(); // erased param sig (as seen from csym) -> sym
    const seen = new Set();
    this.syms.completeHeader(csym);
    const site = this.enter.thisTypeOf(csym);
    const go = (s, depth) => {
      if (!s || seen.has(s)) return;
      seen.add(s);
      this.syms.completeMembers(s);
      for (const m of s.getMembers(name)) {
        if (m.kind !== 'method') continue;
        if (m.isConstructor) continue;
        if (depth > 0 && (m.flags & F.PRIVATE)) continue;
        // static interface methods are not inherited (JLS 8.4.8)
        if (depth > 0 && (m.flags & F.STATIC) && s.isInterface()) continue;
        const sig = this.siteParamSig(site, m);
        const prev = seenSigs.get(sig);
        if (prev) {
          // an abstract interface method and a concrete superclass method: keep the concrete one
          if (prev.isAbstract() && !m.isAbstract() && !(m.flags & F.STATIC) && prev.owner.isInterface() && !m.owner.isInterface()) {
            out[out.indexOf(prev)] = m;
            seenSigs.set(sig, m);
          }
          continue;
        }
        seenSigs.set(sig, m);
        out.push(m);
      }
      if (s.superclass && s.superclass.kind === 'class') go(s.superclass.sym, depth + 1);
      for (const i of s.interfaces || []) if (i.kind === 'class') go(i.sym, depth + 1);
      // interfaces implicitly have Object's public methods
      if (s.isInterface() && (!s.interfaces || s.interfaces.length === 0)) go(this.syms.objectSym, depth + 1);
    };
    go(csym, 0);
    return out;
  }

  // erased parameter signature of m as a member of site
  siteParamSig(site, m) {
    let mt = m.type;
    if (site && !(m.flags & F.STATIC) && m.owner !== site.sym) {
      try { mt = this.types.memberType(site, m); } catch (e) { mt = m.type; }
    }
    return mt.params.map((p) => this.types.descriptor(p)).join('');
  }

  erasedParamSig(m) {
    return m.type.params.map((p) => this.types.descriptor(p)).join('');
  }

  // Does csym have a member method (declared or inherited) named `name`?
  // Private methods of supertypes are not members (JLS 8.4.8).
  hasMethodNamed(csym, name) {
    const seen = new Set();
    const go = (s, top) => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      this.syms.completeMembers(s);
      if (s.getMembers(name).some((m) => m.kind === 'method' && !m.isConstructor && (top || !((m.flags & F.PRIVATE) || ((m.flags & F.STATIC) && s.isInterface()))))) return true;
      if (s.superclass && s.superclass.kind === 'class' && go(s.superclass.sym, false)) return true;
      for (const i of s.interfaces || []) if (i.kind === 'class' && go(i.sym, false)) return true;
      if (s.isInterface() && go(this.syms.objectSym, false)) return true;
      return false;
    };
    return go(csym, true);
  }

  methodsInSite(site, name) {
    if (site.kind === 'union') return this.methodsInSite(site.lub || this.syms.objectType, name);
    if (site.kind === 'array') {
      // arrays have Object's methods plus a public clone()
      const ms = this.collectMethods(this.syms.objectSym, name);
      if (name === 'clone') return ms.map((m) => ({ sym: m, arrayClone: true }));
      return ms.map((m) => ({ sym: m }));
    }
    if (site.kind === 'intersection' || site.kind === 'tvar') {
      const bounds = site.kind === 'tvar' ? (site.bounds && site.bounds.length ? site.bounds : [this.syms.objectType]) : site.bounds;
      const out = [];
      const sigs = new Set();
      for (const b of bounds) {
        for (const m of this.methodsInSite(b, name)) {
          const sig = this.erasedParamSig(m.sym);
          if (sigs.has(sig)) continue;
          sigs.add(sig);
          out.push(m);
        }
      }
      return out;
    }
    const c = this.siteClass(site);
    if (!c) return [];
    return this.collectMethods(c, name).map((m) => ({ sym: m }));
  }

  // ---- argument descriptions -----------------------------------------------------
  // args: [{ tree, type, poly }] where poly is null | 'lambda' | 'mref' | 'implicitLambda'
  // phase: 1 strict, 2 loose, 3 varargs

  isApplicable(m, mtype, args, phase) {
    const params = mtype.params;
    const n = params.length;
    const varargs = (m.flags & F.VARARGS) !== 0;
    if (phase < 3) {
      if (args.length !== n) return false;
    } else {
      if (!varargs) return false;
      if (args.length < n - 1) return false;
    }
    for (let i = 0; i < args.length; i++) {
      let formal;
      if (phase === 3 && i >= n - 1) formal = this.types.elemtype(params[n - 1]) || params[n - 1];
      else formal = params[i];
      if (!this.argCompatible(args[i], formal, phase, m)) return false;
    }
    return true;
  }

  argCompatible(arg, formal, phase, m) {
    if (arg.poly === 'invocation' && arg.erasedType) return this.argCompatible({ type: arg.erasedType, poly: null }, formal, phase, m);
    if (arg.poly) return this.potentiallyCompatible(arg, formal, m);
    const a = arg.type;
    if (!a || a.kind === 'unknown') return true;
    const f = this.erasureForApplicability(formal, m);
    if (a.kind === 'null') return f.kind !== 'prim';
    const ae = a.kind === 'prim' ? a : this.types.erasure(a);
    if (phase === 1) {
      if (ae.kind === 'prim' || f.kind === 'prim') return ae.kind === 'prim' && f.kind === 'prim' && this.types.isSubtype(ae, f);
      return this.types.isSubtype(ae, f, true) || this.types.isSubtypeUnchecked(a, f);
    }
    // loose: boxing / unboxing allowed
    if (ae.kind === 'prim' && f.kind !== 'prim') {
      if (ae.tag === 'void') return false;
      return this.types.isSubtype(this.types.boxedClass(ae), f, true);
    }
    if (ae.kind !== 'prim' && f.kind === 'prim') {
      const u = this.types.unboxedType(a);
      return !!u && this.types.isSubtype(u, f);
    }
    if (ae.kind === 'prim') return this.types.isSubtype(ae, f);
    return this.types.isSubtype(ae, f, true) || this.types.isSubtypeUnchecked(a, f);
  }

  // erasure where the method's own type variables erase to their bounds
  erasureForApplicability(formal) {
    return this.types.erasure(formal);
  }

  potentiallyCompatible(arg, formal) {
    // JLS 15.12.2.1: lambda/mref is potentially compatible with a functional interface
    // (or a type variable of the method)
    if (formal.kind === 'tvar' || (arg.poly === 'invocation' && !arg.erasedType)) return true;
    if (arg.poly === 'invocation') {
      const fe0 = this.types.erasure(formal);
      return fe0.kind === 'prim' ? !!this.types.unboxedType(arg.erasedType) : this.types.isSubtype(arg.erasedType, fe0, true);
    }
    const fe = this.types.erasure(formal);
    if (fe.kind !== 'class') return false;
    const fn = this.findFunctionalMethod(fe.sym);
    if (!fn) return false;
    if (arg.poly === 'lambda') {
      if (fn.type.params.length !== arg.arity) return false;
      const voidRet = fn.type.ret.kind === 'prim' && fn.type.ret.tag === 'void';
      if (voidRet && !arg.voidCompatible) return false;
      if (!voidRet && !arg.valueCompatible) return false;
      return true;
    }
    if (arg.poly === 'mref') return arg.arityOk ? arg.arityOk(fn.type.params.length) : true;
    if (arg.poly === 'invocation') {
      if (!arg.erasedType) return true;
      const fe = this.types.erasure(formal);
      return fe.kind === 'prim' ? !!this.types.unboxedType(arg.erasedType) : this.types.isSubtype(arg.erasedType, fe, true);
    }
    if (arg.poly === 'cond') {
      return arg.branches.every((b) => this.potentiallyCompatible(b, formal));
    }
    if (arg.poly === 'switch') return true;
    return true;
  }

  // ---- accessibility (JLS 6.6) ------------------------------------------------------
  outermostClass(c) {
    let x = c;
    for (;;) {
      let o = x.owner;
      while (o && o.kind === 'method') o = o.owner;
      if (!o || o.kind !== 'class') return x;
      x = o;
    }
  }

  packageOf(c) {
    let o = c;
    while (o && o.kind !== 'pkg') o = o.owner;
    return o ? o.fullName : '';
  }

  isAccessible(sym, fromClass) {
    if (!fromClass) return true;
    const f = sym.flags;
    if (f & F.PUBLIC) return true;
    const owner = sym.owner && sym.owner.kind === 'class' ? sym.owner : null;
    if (!owner) return true;
    if (f & F.PRIVATE) return this.outermostClass(owner) === this.outermostClass(fromClass);
    if (this.packageOf(owner) === this.packageOf(fromClass)) return true;
    if (f & F.PROTECTED) {
      for (let c = fromClass; c; ) {
        if (this.syms.isSubClass(c, owner)) return true;
        let o = c.owner;
        while (o && o.kind === 'method') o = o.owner;
        c = o && o.kind === 'class' ? o : null;
      }
    }
    return false;
  }

  // Choose among candidate methods. candidates: [{sym, ...}] with site for member types.
  // Returns {sym, mtype, varargs, candidate} or null.
  selectMethod(site, candidates, args, explicitTypeargs, fromClass) {
    if (fromClass) {
      const acc = candidates.filter((c) => this.isAccessible(c.sym, fromClass));
      if (acc.length) candidates = acc;
    }
    for (let phase = 1; phase <= 3; phase++) {
      const applicable = [];
      for (const cand of candidates) {
        const m = cand.sym;
        const mtype = this.memberMethodType(site, m, cand);
        if (explicitTypeargs && explicitTypeargs.length && mtype.typarams.length === explicitTypeargs.length) {
          // explicit type arguments replace inference
          const inst = this.types.subst(mtype, mtype.typarams, explicitTypeargs);
          inst.typarams = [];
          if (this.isApplicable(m, inst, args, phase)) applicable.push({ cand, mtype: inst, phase });
          continue;
        }
        if (this.isApplicable(m, mtype, args, phase)) applicable.push({ cand, mtype, phase });
      }
      if (applicable.length === 0) continue;
      const best = this.mostSpecific(applicable, args, phase);
      return { sym: best.cand.sym, mtype: best.mtype, varargs: phase === 3, candidate: best.cand };
    }
    return null;
  }

  memberMethodType(site, m, cand) {
    if (cand && cand.arrayClone) {
      return new T.MethodType([], site, [], []);
    }
    if (!site || m.flags & F.STATIC) return m.type;
    let s = site;
    if (s.kind === 'class' || s.kind === 'tvar' || s.kind === 'intersection') s = this.types.capture(s.kind === 'class' ? s : s);
    return this.types.memberType(s, m);
  }

  mostSpecific(list, args, phase) {
    if (list.length === 1) return list[0];
    let best = [];
    for (const a of list) {
      if (list.every((b) => a === b || this.moreSpecific(a, b, args, phase))) best.push(a);
    }
    if (best.length === 0) {
      // fall back: prefer non-abstract, then first
      best = list;
    }
    if (best.length > 1) {
      // same signature from several supertypes: prefer concrete, then most specific return type
      const concrete = best.filter((x) => !x.cand.sym.isAbstract());
      if (concrete.length) best = concrete;
      best.sort((x, y) => {
        const rx = this.types.erasure(x.mtype.ret);
        const ry = this.types.erasure(y.mtype.ret);
        if (this.types.isSameType(rx, ry)) return 0;
        return this.types.isSubtype(rx, ry) ? -1 : (this.types.isSubtype(ry, rx) ? 1 : 0);
      });
    }
    return best[0];
  }

  moreSpecific(a, b, args, phase) {
    const pa = a.mtype.params;
    const pb = b.mtype.params;
    const n = args.length;
    const k = Math.max(n, pa.length, pb.length);
    const paramAt = (ps, i, isVarargs) => {
      if (isVarargs && i >= ps.length - 1) return this.types.elemtype(ps[ps.length - 1]) || ps[ps.length - 1];
      return ps[i];
    };
    const va = phase === 3;
    const limit = va ? k : n;
    let strictlyBetter = false;
    for (let i = 0; i < limit; i++) {
      const s = paramAt(pa, i, va);
      const t = paramAt(pb, i, va);
      if (!s || !t) continue;
      const arg = args[i];
      if (arg && arg.poly === 'invocation' && !arg.erasedType) continue;
      if (arg && arg.poly === 'invocation') {
        const se0 = this.types.erasure(s);
        const te0 = this.types.erasure(t);
        if (this.types.isSameType(se0, te0)) continue;
        if (!this.types.isSubtype(se0, te0, true)) return false;
        strictlyBetter = true;
        continue;
      }
      if (arg && arg.poly && (arg.poly === 'lambda' || arg.poly === 'mref')) {
        const r = this.functionalMoreSpecific(s, t, arg);
        if (r === false) return false;
        continue;
      }
      const se = this.types.erasure(s);
      const te = this.types.erasure(t);
      if (this.types.isSameType(se, te)) continue;
      if (se.kind === 'prim' && te.kind === 'prim') {
        if (!this.types.isSubtype(se, te)) return false;
        strictlyBetter = true;
        continue;
      }
      if (se.kind === 'prim' && te.kind !== 'prim') {
        // m(int) vs m(Object) with an int argument: int is more specific in loose phase
        if (arg && arg.type && arg.type.kind === 'prim') { strictlyBetter = true; continue; }
        return false;
      }
      if (se.kind !== 'prim' && te.kind === 'prim') {
        if (arg && arg.type && arg.type.kind !== 'prim' && arg.type.kind !== 'null') { strictlyBetter = true; continue; }
        return false;
      }
      if (!this.types.isSubtype(se, te, true)) return false;
      strictlyBetter = true;
    }
    if (!strictlyBetter && va && pa.length !== pb.length) {
      return pa.length >= pb.length;
    }
    if (!strictlyBetter) {
      // identical parameter types: generic vs non-generic, or inherited duplicates
      if (a.cand.sym.type.typarams.length === 0 && b.cand.sym.type.typarams.length > 0) return true;
      if (this.syms.isSubClass(a.cand.sym.owner, b.cand.sym.owner)) return true;
      return !b.cand.sym.isAbstract() ? false : true;
    }
    return true;
  }

  // 15.12.2.5 for functional interface parameter types with a lambda/mref argument
  functionalMoreSpecific(s, t, arg) {
    const se = this.types.erasure(s);
    const te = this.types.erasure(t);
    if (se.kind !== 'class' || te.kind !== 'class') return true;
    if (this.types.isSubtype(se, te)) return true;
    if (this.types.isSubtype(te, se)) return false;
    const fs = this.findFunctionalMethod(se.sym);
    const ft = this.findFunctionalMethod(te.sym);
    if (!fs || !ft) return true;
    const rs = fs.type.ret;
    const rt = ft.type.ret;
    if (rt.kind === 'prim' && rt.tag === 'void') return true;
    if (rs.kind === 'prim' && rs.tag === 'void') return false;
    // primitive vs reference return preferences for lambda bodies
    if (rs.kind === 'prim' && rt.kind !== 'prim') return arg.returnsPrimitive !== false;
    if (rs.kind !== 'prim' && rt.kind === 'prim') return arg.returnsPrimitive === false;
    return true;
  }

  // ---- functional interfaces ------------------------------------------------------
  // The single abstract method of a functional interface (or null).
  findFunctionalMethod(csym) {
    if (this.fnCache.has(csym)) return this.fnCache.get(csym);
    this.fnCache.set(csym, null);
    this.syms.completeMembers(csym);
    if (!csym.isInterface()) return null;
    // key -> [methods]; a method is overridden when another one with the same
    // key is declared in a subinterface of its owner
    const byKey = new Map();
    const seen = new Set();
    const objectSigs = new Set(['equals(Ljava/lang/Object;)', 'hashCode()', 'toString()']);
    const site = this.enter.thisTypeOf(this.syms.completeHeader(csym));
    const go = (s) => {
      if (!s || seen.has(s)) return;
      seen.add(s);
      this.syms.completeMembers(s);
      for (const list of s.members.values()) {
        for (const m of list) {
          if (m.kind !== 'method' || (m.flags & F.STATIC) || (m.flags & F.PRIVATE)) continue;
          const key = `${m.name}(${this.siteParamSig(site, m)})`;
          if (objectSigs.has(key)) continue;
          if (!byKey.has(key)) byKey.set(key, []);
          byKey.get(key).push(m);
        }
      }
      for (const i of s.interfaces || []) if (i.kind === 'class') go(i.sym);
    };
    go(csym);
    const remaining = [];
    for (const list of byKey.values()) {
      const effective = list.filter((m) => !list.some((o) => o !== m && o.owner !== m.owner && this.syms.isSubClass(o.owner, m.owner)));
      if (effective.some((m) => !m.isAbstract())) continue;
      remaining.push(effective.find((m) => m.owner === csym) || effective[0]);
    }
    // methods with override-equivalent signatures under generics count once
    let result = null;
    if (remaining.length === 1) result = remaining[0];
    else if (remaining.length > 1) {
      const names = new Set(remaining.map((m) => m.name));
      const arities = new Set(remaining.map((m) => m.params.length));
      if (names.size === 1 && arities.size === 1) {
        // e.g. interface I<T> { void m(T t); } interface J extends I<String> { void m(String s); }
        result = remaining.find((m) => m.owner === csym) || remaining[0];
      }
    }
    this.fnCache.set(csym, result);
    return result;
  }

  // Function type of functional interface type `t` (non-wildcard parameterization).
  functionType(t) {
    if (!t) return null;
    let ft = t;
    if (ft.kind === 'intersection') {
      ft = ft.bounds.find((b) => b.kind === 'class' && this.findFunctionalMethod(b.sym)) || ft.bounds[0];
    }
    if (ft.kind !== 'class') return null;
    const m = this.findFunctionalMethod(ft.sym);
    if (!m) return null;
    const site = this.nonWildcardParameterization(ft);
    const mt = this.types.memberType(site, m);
    return { sym: m, type: mt, site };
  }

  // JLS 9.9
  nonWildcardParameterization(t) {
    if (t.kind !== 'class' || !t.args.some((a) => a.kind === 'wildcard')) return t;
    const sym = this.syms.completeHeader(t.sym);
    const formals = sym.typarams || [];
    const args = t.args.map((a, i) => {
      if (a.kind !== 'wildcard') return a;
      if (a.bk === 'unbound') {
        const b = formals[i] && formals[i].bounds && formals[i].bounds[0];
        return b && !this.mentions(b, formals) ? b : this.syms.objectType;
      }
      if (a.bk === 'extends') return a.bound;
      return a.bound; // ? super B -> B
    });
    return new T.ClassType(t.sym, args, t.outer);
  }

  mentions(t, vars) {
    if (!t) return false;
    switch (t.kind) {
      case 'tvar': return vars.includes(t);
      case 'class': return t.args.some((a) => this.mentions(a, vars)) || (t.outer && this.mentions(t.outer, vars));
      case 'array': return this.mentions(t.elem, vars);
      case 'wildcard': return t.bound ? this.mentions(t.bound, vars) : false;
      case 'intersection': return t.bounds.some((b) => this.mentions(b, vars));
      case 'method': return t.params.some((p) => this.mentions(p, vars)) || this.mentions(t.ret, vars);
      default: return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Inference context for one generic method invocation (or diamond).

class InferenceContext {
  constructor(types, syms, vars) {
    this.types = types;
    this.syms = syms;
    // fresh inference variables mirroring the declared type variables
    this.decl = vars;
    this.ivars = vars.map((v) => {
      const iv = new T.TypeVar(v.name, v.owner);
      iv.isInferenceVar = true;
      return iv;
    });
    for (let i = 0; i < vars.length; i++) {
      this.ivars[i].bounds = (vars[i].bounds || [syms.objectType]).map((b) => types.subst(b, vars, this.ivars));
    }
    this.eq = this.ivars.map(() => []);
    this.lower = this.ivars.map(() => []);
    this.upper = this.ivars.map((iv) => iv.bounds.slice());
    this.inst = this.ivars.map(() => null);
    this.failed = false;
  }

  // substitute declared vars by inference vars
  asUndet(t) { return this.types.subst(t, this.decl, this.ivars); }

  idx(t) { return t && t.kind === 'tvar' ? this.ivars.indexOf(t) : -1; }

  isProper(t) {
    if (!t) return true;
    switch (t.kind) {
      case 'tvar': return this.ivars.indexOf(t) < 0;
      case 'class': return t.args.every((a) => this.isProper(a)) && (!t.outer || this.isProper(t.outer));
      case 'array': return this.isProper(t.elem);
      case 'wildcard': return !t.bound || this.isProper(t.bound);
      case 'intersection': return t.bounds.every((b) => this.isProper(b));
      default: return true;
    }
  }

  addBound(list, i, t) {
    if (!t) return;
    if (t.kind === 'prim') t = this.types.boxedClass(t);
    if (t.kind === 'null') return;
    if (list[i].some((x) => this.types.isSameType(x, t))) return;
    list[i].push(t);
  }

  // ⟨S → T⟩ in a loose invocation context
  compatible(s, t) {
    if (!s || !t) return;
    if (s.kind === 'prim' && t.kind !== 'prim') {
      if (s.tag === 'void') return;
      s = this.types.boxedClass(s);
    } else if (s.kind !== 'prim' && t.kind === 'prim') {
      return;
    }
    if (s.kind === 'prim') return;
    this.subtype(s, t, 0);
  }

  subtype(s, t, depth) {
    if (depth > 30 || !s || !t) return;
    if (s.kind === 'null' || s.kind === 'unknown') return;
    const ti = this.idx(t);
    if (ti >= 0) { this.addBound(this.lower, ti, s); return; }
    const si = this.idx(s);
    if (si >= 0) { this.addBound(this.upper, si, t); return; }
    if (t.kind === 'class') {
      if (!t.args.length) return;
      let sup = null;
      if (s.kind === 'class' || s.kind === 'tvar' || s.kind === 'intersection' || s.kind === 'array') sup = this.types.asSuper(this.types.capture(s.kind === 'class' ? s : s), t.sym);
      if (!sup || !sup.args.length) return;
      for (let i = 0; i < t.args.length && i < sup.args.length; i++) this.contains(sup.args[i], t.args[i], depth + 1);
      return;
    }
    if (t.kind === 'array' && s.kind === 'array') {
      if (s.elem.kind !== 'prim' && t.elem.kind !== 'prim') this.subtype(s.elem, t.elem, depth + 1);
      return;
    }
    if (t.kind === 'intersection') {
      for (const b of t.bounds) this.subtype(s, b, depth + 1);
    }
  }

  // S is contained by T (type arguments)
  contains(s, t, depth) {
    if (t.kind === 'wildcard') {
      if (t.bk === 'unbound') return;
      if (t.bk === 'extends') {
        if (s.kind === 'wildcard') {
          if (s.bk === 'extends') this.subtype(s.bound, t.bound, depth + 1);
          else if (s.bk === 'unbound') this.subtype(this.syms.objectType, t.bound, depth + 1);
        } else if (s.kind === 'tvar' && s.captured) {
          this.subtype(s.upperBound() || this.syms.objectType, t.bound, depth + 1);
        } else this.subtype(s, t.bound, depth + 1);
        return;
      }
      // ? super B
      if (s.kind === 'wildcard') {
        if (s.bk === 'super') this.subtype(t.bound, s.bound, depth + 1);
      } else if (s.kind === 'tvar' && s.captured) {
        if (s.lower) this.subtype(t.bound, s.lower, depth + 1);
      } else this.subtype(t.bound, s, depth + 1);
      return;
    }
    this.equal(s.kind === 'wildcard' ? null : s, t, depth + 1);
  }

  equal(s, t, depth) {
    if (!s || !t || depth > 30) return;
    const ti = this.idx(t);
    if (ti >= 0) { this.addBound(this.eq, ti, s); return; }
    const si = this.idx(s);
    if (si >= 0) { this.addBound(this.eq, si, t); return; }
    if (s.kind === 'class' && t.kind === 'class' && s.sym === t.sym) {
      for (let i = 0; i < Math.min(s.args.length, t.args.length); i++) {
        const a = s.args[i];
        const b = t.args[i];
        if (a.kind === 'wildcard' && b.kind === 'wildcard') {
          if (a.bound && b.bound) this.equal(a.bound, b.bound, depth + 1);
        } else if (a.kind !== 'wildcard' && b.kind !== 'wildcard') this.equal(a, b, depth + 1);
      }
      return;
    }
    if (s.kind === 'array' && t.kind === 'array') this.equal(s.elem, t.elem, depth + 1);
  }

  // Resolve a subset (or all) of the variables. Variables mentioned in the
  // bounds of others are resolved first where possible.
  resolve(indices) {
    const todo = indices || this.ivars.map((_, i) => i);
    for (let round = 0; round < 4; round++) {
      let progress = false;
      for (const i of todo) {
        if (this.inst[i]) continue;
        const r = this.resolveOne(i, round >= 2);
        if (r) { this.inst[i] = r; progress = true; }
      }
      if (!progress) break;
      if (todo.every((i) => this.inst[i])) break;
    }
    for (const i of todo) if (!this.inst[i]) this.inst[i] = this.resolveOne(i, true) || this.types.erasure(this.decl[i]);
    return this.inst;
  }

  substInst(t) {
    const known = [];
    const vals = [];
    for (let i = 0; i < this.ivars.length; i++) if (this.inst[i]) { known.push(this.ivars[i]); vals.push(this.inst[i]); }
    return this.types.subst(t, known, vals);
  }

  resolveOne(i, force) {
    const proper = (list) => list.map((b) => this.substInst(b)).filter((b) => this.isProper(b));
    const eqs = proper(this.eq[i]);
    if (eqs.length) return eqs[0];
    const lows = proper(this.lower[i]);
    if (lows.length) {
      const l = lows.length === 1 ? lows[0] : this.types.lub(lows);
      return l.kind === 'tvar' && l.captured && !force ? l : l;
    }
    if (!force && (this.eq[i].length || this.lower[i].length)) return null;
    const ups = proper(this.upper[i]).filter((u) => !this.types.isObject(u));
    if (ups.length) {
      if (ups.length === 1) return ups[0];
      let g = ups[0];
      for (let k = 1; k < ups.length; k++) g = this.types.glb(g, ups[k]);
      return g;
    }
    if (!force && this.upper[i].some((u) => !this.isProper(this.substInst(u)))) return null;
    return force ? this.syms.objectType : this.syms.objectType;
  }
}

module.exports = { Resolve, InferenceContext };
