'use strict';

// Lowering analysis: computes the class-structure translation that code
// generation applies while walking attributed trees:
//   - outer instance fields (this$0) of inner classes
//   - captured variables of local and anonymous classes (val$x)
//   - synthetic lambda methods for lambdas and method references
//   - bridge methods
// Results are stored on symbols (csym.trans) and trees (tree.lambdaMethod).

const { F } = require('./flags');
const T = require('./types');
const { MethodSymbol, VarSymbol } = require('./symbols');

const { forEachChild: children } = require('./tree-util');

class Lower {
  constructor(compiler) {
    this.c = compiler;
    this.syms = compiler.syms;
    this.types = compiler.syms.types;
    this.freeVarCache = new Map();
  }

  trans(csym) {
    if (!csym.trans.done) this.lowerClass(csym);
    return csym.trans;
  }

  lowerClass(csym) {
    const tr = csym.trans;
    tr.done = true;
    tr.lambdas = [];
    tr.lambdaCount = 0;
    tr.syntheticMethods = [];
    tr.usesAssert = false;
    if (csym.hasOuterThis) {
      let outer = this.outerClass(csym);
      // declared in a constructor prologue: the outer instance is that of the class under construction
      if (csym.prologueOuter) outer = this.trans(outer).outerClass;
      tr.outerThis = new VarSymbol('this$0', F.FINAL | F.SYNTHETIC, csym, this.syms.erasedType(outer));
      tr.outerThis.isField = true;
      tr.outerClass = outer;
    }
    if (csym.isLocal) {
      tr.captured = this.freeVars(csym);
      tr.capturedFields = new Map();
      for (const v of tr.captured) {
        const f = new VarSymbol(`val$${v.name}`, F.FINAL | F.SYNTHETIC, csym, v.type);
        f.isField = true;
        tr.capturedFields.set(v, f);
      }
    } else {
      tr.captured = [];
      tr.capturedFields = new Map();
    }
    const decl = csym.tree;
    if (decl) this.scanLambdas(csym, decl);
    tr.bridges = this.computeBridges(csym);
  }

  outerClass(csym) {
    let o = csym.owner;
    while (o && o.kind !== 'class') o = o.owner;
    return o;
  }

  // ---- free variables of local classes -------------------------------------
  // Locals referenced in the class (and in local classes it instantiates)
  // that are declared outside of it.
  freeVars(csym) {
    if (this.freeVarCache.has(csym)) return this.freeVarCache.get(csym);
    this.freeVarCache.set(csym, []);
    const declaredInside = new Set();
    const used = [];
    const addUse = (v) => { if (!used.includes(v)) used.push(v); };
    const visit = (n) => {
      if (n.tag === 'VarDecl' && n.sym) declaredInside.add(n.sym);
      if (n.tag === 'Ident' && n.sym && n.sym.kind === 'var' && n.sym.isLocal) addUse(n.sym);
      if (n.tag === 'NewClass') {
        const target = n.anonClass || (n.sym && n.sym.owner);
        if (target && target.isLocal && target !== csym) for (const v of this.freeVars(target)) addUse(v);
      }
      if (n.tag === 'Apply' && n.ctorCall === 'super' && n.sym && n.sym.owner.isLocal && n.sym.owner !== csym) {
        for (const v of this.freeVars(n.sym.owner)) addUse(v);
      }
      if (n.tag === 'Reference' && n.refKind === 'ctor' && n.sym && n.sym.owner.isLocal) {
        for (const v of this.freeVars(n.sym.owner)) addUse(v);
      }
      if (n.tag === 'Lambda') for (const p of n.params) if (p.sym) declaredInside.add(p.sym);
      if (n.tag === 'Catch' && n.param.sym) declaredInside.add(n.param.sym);
      children(n, visit);
    };
    const decl = csym.tree;
    visit(decl);
    // a local class that extends another local class passes that class's captures to super()
    const sup = csym.superclass && csym.superclass.kind === 'class' ? csym.superclass.sym : null;
    if (sup && sup.isLocal && sup !== csym) for (const v of this.freeVars(sup)) addUse(v);
    const free = used.filter((v) => !declaredInside.has(v) && !(v.constValue !== undefined && v.constValue !== null && v.constValue !== 'computing'));
    this.freeVarCache.set(csym, free);
    return free;
  }

  // ---- lambdas ------------------------------------------------------------------
  scanLambdas(csym, decl) {
    const tr = csym.trans;
    const self = this;
    // walk the class body, but not nested class declarations (they are their own classes)
    const walk = (n, enclosingLambdas) => {
      if (n.tag === 'ClassDecl' && n !== decl) return;
      if (n.tag === 'ClassDef') return;
      if (n.tag === 'NewClass' && n.body) {
        // arguments belong to us, the body to the anonymous class
        if (n.encl) walk(n.encl, enclosingLambdas);
        for (const a of n.args) walk(a, enclosingLambdas);
        if (n.anonClass) {
          if (n.anonClass.hasOuterThis) this.markThis(enclosingLambdas);
          this.captureForClass(n.anonClass, enclosingLambdas);
        }
        return;
      }
      if (n.tag === 'NewClass' && n.sym && n.sym.owner.isLocal) {
        const lc = n.sym.owner;
        if (lc.hasOuterThis) this.markThis(enclosingLambdas);
        this.captureForClass(lc, enclosingLambdas);
      }
      if (n.tag === 'Lambda') {
        const lm = self.makeLambdaMethod(csym, n, enclosingLambdas);
        walk(n.body, enclosingLambdas.concat([lm]));
        return;
      }
      if (n.tag === 'Reference') {
        const lm = self.makeRefMethod(csym, n, enclosingLambdas);
        // the qualifier expression is evaluated outside
        if (!n.qualIsType && n.expr && n.refKind === 'bound') walk(n.expr, enclosingLambdas);
        if (lm.usesThis) this.markThis(enclosingLambdas);
        return;
      }
      if (n.tag === 'Ident' && n.sym && n.sym.kind === 'var' && n.sym.isLocal) {
        // captured by the enclosing lambdas from the innermost outward, up to
        // the one that declares it
        if (!(n.sym.constValue !== undefined && n.sym.constValue !== null && n.sym.constValue !== 'computing')) this.captureInto(enclosingLambdas, n.sym);
      }
      if (enclosingLambdas.length && this.usesThis(n, csym)) this.markThis(enclosingLambdas);
      if (n.tag === 'VarDecl' && n.sym && enclosingLambdas.length) enclosingLambdas[enclosingLambdas.length - 1].declared.add(n.sym);
      if (n.tag === 'Catch' && n.param.sym && enclosingLambdas.length) enclosingLambdas[enclosingLambdas.length - 1].declared.add(n.param.sym);
      if (n.tag === 'Assert') tr.usesAssert = true;
      children(n, (c) => walk(c, enclosingLambdas));
    };
    for (const d of decl.defs) {
      if (d.tag === 'ClassDecl') continue;
      if (d.tag === 'VarDecl' && d.enumConstant) {
        for (const a of d.enumConstant.args) walk(a, []);
        continue;
      }
      walk(d, []);
    }
    // enum constant bodies are separate classes; record compact ctor etc are methods
  }

  captureForClass(lc, enclosingLambdas) {
    if (!enclosingLambdas.length) return;
    for (const v of this.freeVars(lc)) this.captureInto(enclosingLambdas, v);
  }

  captureInto(lambdas, v) {
    for (let i = lambdas.length - 1; i >= 0; i--) {
      const lm = lambdas[i];
      if (lm.declared.has(v)) return;
      if (!lm.captured.includes(v)) lm.captured.push(v);
    }
  }

  markThis(lms) { for (const lm of lms) lm.usesThis = true; }

  // does this node (by itself) need `this` of csym?
  usesThis(n, csym) {
    switch (n.tag) {
      case 'Ident':
        if (n.name === 'this' || n.name === 'super') return true;
        if (n.sym && n.sym.kind === 'var' && n.sym.isField && !(n.sym.flags & F.STATIC) && !n.constValue) return true;
        if (n.sym && n.sym.kind === 'var' && n.sym.isLocal && this.capturedViaField(n.sym, csym)) return true;
        return false;
      case 'Select':
        return !!n.outerThis || !!n.qualifiedSuper;
      case 'Apply':
        if (n.receiver && (n.receiver.kind === 'this' || n.receiver.kind === 'outer' || n.receiver.kind === 'super' || n.receiver.kind === 'ifaceSuper' || n.receiver.kind === 'outerSuper')) return true;
        if (n.ctorCall) return true;
        return false;
      case 'NewClass':
        if (n.implicitOuter) return true;
        if (n.sym && n.sym.owner.isLocal && n.sym.owner.hasOuterThis) return true;
        return false;
      default:
        return false;
    }
  }

  // inside a local class, a captured variable is read from a val$ field
  capturedViaField(v, csym) {
    return csym.isLocal && this.trans(csym).capturedFields.has(v);
  }

  // all variables declared anywhere inside a lambda (not in nested classes)
  declaredIn(tree) {
    const out = new Set(tree.params.map((p) => p.sym));
    const visit = (n) => {
      if (n.tag === 'ClassDecl' || n.tag === 'ClassDef') return;
      if (n.tag === 'VarDecl' && n.sym) out.add(n.sym);
      if (n.tag === 'Lambda') for (const p of n.params) if (p.sym) out.add(p.sym);
      if (n.tag === 'Catch' && n.param.sym) out.add(n.param.sym);
      children(n, visit);
    };
    visit(tree.body);
    return out;
  }

  makeLambdaMethod(csym, tree, enclosing) {
    const tr = csym.trans;
    const lm = {
      kind: 'lambda',
      tree,
      owner: csym,
      captured: [],
      declared: this.declaredIn(tree),
      usesThis: false,
      name: null,
      index: tr.lambdaCount++,
    };
    // captured vars recorded by Attr are a good start; walk will add the rest
    if (tree.lambdaInfo && tree.lambdaInfo.usesThis) lm.usesThis = true;
    tree.lambdaMethod = lm;
    tr.lambdas.push(lm);
    return lm;
  }

  makeRefMethod(csym, tree, enclosing) {
    const tr = csym.trans;
    const lm = {
      kind: 'ref',
      tree,
      owner: csym,
      captured: [],
      declared: new Set(),
      usesThis: false,
      name: null,
      index: tr.lambdaCount++,
    };
    if (tree.refKind === 'super') lm.usesThis = true;
    if (tree.refKind === 'ctor' && tree.sym && tree.sym.owner.hasOuterThis) lm.usesThis = true;
    if (tree.refKind === 'ctor' && tree.sym && tree.sym.owner.isLocal) {
      for (const v of this.freeVars(tree.sym.owner)) if (!lm.captured.includes(v)) lm.captured.push(v);
    }
    tree.lambdaMethod = lm;
    tr.lambdas.push(lm);
    return lm;
  }

  // ---- bridges ------------------------------------------------------------------
  // A bridge is needed when a method of csym overrides a supertype method whose
  // erased descriptor differs (JLS 15.12.4.5).
  computeBridges(csym) {
    if (csym.isInterface() && !csym.tree) return [];
    const bridges = [];
    const types = this.types;
    this.syms.completeMembers(csym);
    const site = this.c.enter.thisTypeOf(csym);
    const own = [];
    for (const list of csym.members.values()) for (const m of list) if (m.kind === 'method' && !m.isConstructor && !(m.flags & (F.STATIC | F.PRIVATE))) own.push(m);
    // also inherited concrete methods that implement interface methods with a different erasure
    const have = new Set(own.map((m) => m.name + types.descriptor(m.type)));
    const seen = new Set();
    const supers = [];
    const collect = (t) => {
      if (!t || t.kind !== 'class' || seen.has(t.sym)) return;
      seen.add(t.sym);
      supers.push(t);
      const s = this.syms.completeHeader(t.sym);
      if (s.superclass) collect(types.substSuper(t, s.superclass));
      for (const i of s.interfaces || []) collect(types.substSuper(t, i));
    };
    const cs = this.syms.completeHeader(csym);
    if (cs.superclass) collect(cs.superclass);
    for (const i of cs.interfaces || []) collect(i);
    const candidates = own.slice();
    // inherited implementations from superclasses (for interface methods newly implemented here)
    for (const st of supers) {
      if (st.sym.isInterface()) continue;
      this.syms.completeMembers(st.sym);
      for (const list of st.sym.members.values()) for (const m of list) {
        if (m.kind === 'method' && !m.isConstructor && !(m.flags & (F.STATIC | F.PRIVATE | F.ABSTRACT)) && !candidates.some((o) => o.name === m.name && this.sameParams(site, o, m))) candidates.push(m);
      }
    }
    for (const m of candidates) {
      const mDesc = types.descriptor(m.type);
      const mt = m.owner === csym ? m.type : types.memberType(site, m);
      for (const st of supers) {
        this.syms.completeMembers(st.sym);
        for (const o of st.sym.getMembers(m.name)) {
          if (o.kind !== 'method' || o === m || o.isConstructor || (o.flags & (F.STATIC | F.PRIVATE))) continue;
          if (o.params.length !== m.params.length) continue;
          const oDesc = types.descriptor(o.type);
          if (oDesc === mDesc) continue;
          // does m override o (as members of csym)?
          const ot = types.memberType(site, o);
          if (!ot.params.every((p, i) => types.isSameType(types.erasure(p), types.erasure(mt.params[i])))) continue;
          const key = m.name + oDesc;
          if (have.has(key)) continue;
          // only when m is declared in csym, or csym newly brings o into play
          if (m.owner !== csym && !this.needsInheritedBridge(csym, m, o)) continue;
          have.add(key);
          bridges.push({ name: m.name, desc: oDesc, target: m, overridden: o, erased: types.erasure(o.type) });
        }
      }
    }
    return bridges;
  }

  sameParams(site, a, b) {
    const ta = this.types.memberType(site, a);
    const tb = this.types.memberType(site, b);
    if (ta.params.length !== tb.params.length) return false;
    return ta.params.every((p, i) => this.types.descriptor(p) === this.types.descriptor(tb.params[i]));
  }

  // An inherited method m (from a superclass) implementing interface method o:
  // the bridge is needed in csym unless m's class already has it.
  needsInheritedBridge(csym, m, o) {
    const ownerTr = m.owner.tree ? this.trans(m.owner) : null;
    if (ownerTr && ownerTr.bridges.some((b) => b.name === m.name && b.desc === this.types.descriptor(o.type))) return false;
    return this.syms.isSubClass(m.owner, o.owner) ? false : true;
  }
}

module.exports = { Lower, children };
