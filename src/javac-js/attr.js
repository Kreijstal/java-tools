'use strict';

// Attribution: types, symbols and constant values for every expression and
// statement. Results are stored on the tree nodes:
//   tree.type        static type of an expression
//   tree.sym         resolved symbol (Ident/Select/Apply/NewClass/Reference/VarDecl)
//   tree.mtype       instantiated method type of an invocation
//   tree.constValue  compile-time constant value (undefined if not constant)

const { F } = require('./flags');
const T = require('./types');
const CF = require('./constfold');
const { MethodSymbol, VarSymbol } = require('./symbols');
const { Env, CompileError, qualifiedName } = require('./enter');
const { Resolve, InferenceContext } = require('./resolve');
const { forEachChild } = require('./tree-util');

const PRIM = T.PRIM;

function unparen(t) {
  while (t && t.tag === 'Parens') t = t.expr;
  return t;
}

class Attr {
  constructor(compiler) {
    this.c = compiler;
    this.syms = compiler.syms;
    this.types = compiler.syms.types;
    this.enter = compiler.enter;
    this.rs = new Resolve(compiler);
    this.attributed = new Set();
    this.localClassCounter = new Map();
    this.pendingLocalClasses = [];
  }

  error(msg, env, pos) {
    const unit = env && env.unit;
    throw new CompileError(msg, unit ? unit.file : null, pos, unit ? unit.lineCol : null);
  }

  // ---- well-known types ------------------------------------------------------------
  get stringType() { return this._str || (this._str = this.syms.typeOf('java.lang.String')); }
  get objectType() { return this.syms.objectType; }
  typeOf(n) { return this.syms.typeOf(n); }

  // ---- classes --------------------------------------------------------------------
  attribClass(csym) {
    if (this.attributed.has(csym)) return;
    this.attributed.add(csym);
    this.syms.completeMembers(csym);
    const decl = csym.tree;
    if (!decl) return;
    const cenv = this.enter.classEnv(csym);
    // superclass first so that inherited constant values etc. are ready
    for (const d of decl.defs) {
      switch (d.tag) {
        case 'VarDecl': this.attribField(d, csym, cenv); break;
        case 'MethodDecl': this.attribMethod(d, csym); break;
        case 'Block': {
          const env = cenv.dup('block');
          env.isStatic = !!d.isStatic;
          env.method = null;
          env.info = { csym, initializer: true };
          this.attribBlockStats(d.stats, env);
          break;
        }
        case 'ClassDecl': break;
        default: break;
      }
    }
    for (const d of decl.defs) if (d.tag === 'ClassDecl' && d.sym) this.attribClass(d.sym);
  }

  attribField(d, csym, cenv) {
    const f = d.sym;
    if (d.enumConstant) {
      this.attribEnumConstant(d, csym, cenv);
      return;
    }
    if (!d.init || d.init.type) return;
    const env = cenv.dup('block');
    env.isStatic = (f.flags & F.STATIC) !== 0;
    env.method = null;
    env.info = { csym, fieldInit: f };
    this.attribExprCoerce(d.init, env, f.type);
    if (f.flags & F.FINAL && d.init.constValue !== undefined && (f.type.kind === 'prim' || this.isString(f.type))) {
      if (f.constValue === undefined || f.constValue === 'computing') f.constValue = this.coerceConst(d.init.constValue, d.init.type, f.type);
    } else if (f.constValue === undefined || f.constValue === 'computing') f.constValue = null;
  }

  attribEnumConstant(d, csym, cenv) {
    const ec = d.enumConstant;
    if (ec.attributed) return;
    ec.attributed = true;
    const env = cenv.dup('block');
    env.isStatic = true;
    env.method = null;
    env.info = { csym, enumConstant: d };
    const args = this.attribArgs(ec.args, env);
    const site = this.syms.erasedType(csym);
    if (ec.body) {
      // anonymous subclass of the enum
      const body = ec.body;
      const name = this.allocLocalName(csym, '');
      const anon = this.enter.enterLocalClass(body, env, '', name);
      anon.flags |= F.ENUM | F.FINAL;
      anon.flags &= ~F.STATIC;
      anon.hasOuterThis = false;
      anon.superclass = site;
      anon.enumConstantBody = true;
      ec.anonSym = anon;
      this.enter.completeHeader(anon);
      const ctor = this.resolveConstructor(env, site, args, [], d.pos);
      ec.ctor = ctor.sym;
      ec.mtype = ctor.mtype;
      ec.varargs = ctor.varargs;
      this.finishArgs(ec.args, args, ctor.mtype, ctor.varargs, env);
      this.makeAnonConstructor(anon, ctor, args, env);
      this.attribClass(anon);
    } else {
      const ctor = this.resolveConstructor(env, site, args, [], d.pos);
      ec.ctor = ctor.sym;
      ec.mtype = ctor.mtype;
      ec.varargs = ctor.varargs;
      this.finishArgs(ec.args, args, ctor.mtype, ctor.varargs, env);
    }
  }

  // constant value of a field (computed on demand, JLS 4.12.4)
  constValueOf(f) {
    if (f.constValue !== undefined) return f.constValue === 'computing' ? null : f.constValue;
    if (!(f.flags & F.FINAL) || !f.tree || !f.tree.init || f.tree.enumConstant) { f.constValue = null; return null; }
    if (!(f.type.kind === 'prim' || this.isString(f.type))) { f.constValue = null; return null; }
    const init = unparen(f.tree.init);
    // quick reject: non-constant shapes
    if (!this.mayBeConstantTree(init)) { f.constValue = null; return null; }
    f.constValue = 'computing';
    const csym = f.owner;
    if (f.isLocal) {
      // local constant variables are attributed in order; reaching here means not yet
      f.constValue = null;
      return null;
    }
    const cenv = this.enter.classEnv(csym);
    const env = cenv.dup('block');
    env.isStatic = (f.flags & F.STATIC) !== 0;
    env.method = null;
    env.info = { csym, fieldInit: f };
    try {
      this.attribExprCoerce(f.tree.init, env, f.type);
    } catch (e) {
      f.constValue = undefined;
      throw e;
    }
    const v = f.tree.init.constValue;
    f.constValue = v === undefined ? null : this.coerceConst(v, f.tree.init.type, f.type);
    return f.constValue;
  }

  mayBeConstantTree(t) {
    t = unparen(t);
    if (!t) return false;
    switch (t.tag) {
      case 'Literal': return t.typetag !== 'null';
      case 'Ident': return true;
      case 'Select': return t.name !== 'class' && t.name !== 'this' && t.name !== 'length';
      case 'Unary': return !t.op.startsWith('pre') && !t.op.startsWith('post') && this.mayBeConstantTree(t.arg);
      case 'Binary': return t.op !== 'instanceof' && this.mayBeConstantTree(t.lhs) && this.mayBeConstantTree(t.rhs);
      case 'Conditional': return this.mayBeConstantTree(t.cond) && this.mayBeConstantTree(t.truepart) && this.mayBeConstantTree(t.falsepart);
      case 'TypeCast': return this.mayBeConstantTree(t.expr);
      default: return false;
    }
  }

  coerceConst(v, from, to) {
    if (v === undefined || v === null) return v;
    const ft = from.kind === 'prim' ? from.tag : 'String';
    let tt = to.kind === 'prim' ? to.tag : 'String';
    if (to.kind === 'class' && !this.isString(to)) {
      const u = this.types.unboxedType(to);
      if (!u) return undefined;
      tt = u.tag;
    }
    if (tt === 'String' && ft !== 'String') return undefined;
    return CF.convert(v, ft, tt);
  }

  isString(t) { return t && t.kind === 'class' && t.sym.fullName === 'java.lang.String'; }

  // ---- methods ------------------------------------------------------------------
  attribMethod(d, csym) {
    const m = d.sym;
    if (!d.body || d.attributed) return;
    d.attributed = true;
    const env = m.env.dup('block');
    env.method = m;
    env.isStatic = (m.flags & F.STATIC) !== 0;
    env.returnType = m.type.ret;
    env.info = { csym, method: m };
    for (const p of m.params) env.addLocal(p);
    if (d.defaultValue) this.attribAnnotationValue(d.defaultValue, env, m.type.ret);
    if (m.isConstructor) {
      // statements up to and including this(...)/super(...) form the prologue,
      // where the instance under construction cannot be used
      const stats = d.body.stats;
      const k = stats.findIndex((st) => st.tag === 'Exec' && unparen(st.expr).tag === 'Apply' && this.isCtorCallTree(unparen(st.expr)));
      env.ctorPrologue = k >= 0;
      for (let i = 0; i < stats.length; i++) {
        this.attribStat(stats[i], env);
        if (i === k) env.ctorPrologue = false;
      }
      env.ctorPrologue = false;
      return;
    }
    this.attribBlockStats(d.body.stats, env);
  }

  isCtorCallTree(a) {
    const m = a.meth;
    return (m.tag === 'Ident' && (m.name === 'this' || m.name === 'super')) || (m.tag === 'Select' && m.name === 'super');
  }

  // A local/anonymous class declared in a constructor prologue has the
  // enclosing instance of the class under construction (if any) as its own.
  markPrologueClass(sym, env) {
    if (!env.ctorPrologue || env.isStatic) return;
    const c = env.clazz;
    sym.prologueOuter = true;
    sym.hasOuterThis = !!c.hasOuterThis;
  }

  attribAnnotationValue(v, env, type) {
    if (v.tag === 'Annotation') return;
    if (v.tag === 'NewArray' && !v.elemtype) {
      const et = this.types.elemtype(type) || type;
      for (const e of v.elems) this.attribAnnotationValue(e, env, et);
      v.type = type;
      return;
    }
    this.attribExprCoerce(v, env, type);
  }

  // ---- statements ---------------------------------------------------------------
  attribBlockStats(stats, env) {
    for (const s of stats) this.attribStat(s, env);
  }

  attribStat(tree, env) {
    switch (tree.tag) {
      case 'Block': {
        const benv = env.dup('block');
        this.attribBlockStats(tree.stats, benv);
        return;
      }
      case 'VarDecl': return this.attribLocalVar(tree, env);
      case 'ClassDef': return this.attribLocalClassDecl(tree.decl, env);
      case 'Exec':
        this.attribExpr(tree.expr, env, null);
        return;
      case 'If': {
        this.attribCond(tree.cond, env);
        this.attribStat(tree.thenp, env.dup('block'));
        if (tree.elsep) this.attribStat(tree.elsep, env.dup('block'));
        return;
      }
      case 'WhileLoop':
        this.attribCond(tree.cond, env);
        this.attribStat(tree.body, env.dup('block'));
        return;
      case 'DoLoop':
        this.attribStat(tree.body, env.dup('block'));
        this.attribCond(tree.cond, env);
        return;
      case 'ForLoop': {
        const fenv = env.dup('block');
        for (const s of tree.init) this.attribStat(s, fenv);
        if (tree.cond) this.attribCond(tree.cond, fenv);
        for (const s of tree.step) this.attribStat(s, fenv);
        this.attribStat(tree.body, fenv.dup('block'));
        return;
      }
      case 'ForeachLoop': {
        const fenv = env.dup('block');
        const et = this.attribExpr(tree.expr, env, null);
        let elemType;
        const ae = this.types.elemtype(et);
        if (ae) elemType = ae;
        else {
          const iterSym = this.syms.symOf('java.lang.Iterable');
          const sup = this.types.asSuper(this.types.capture(et), iterSym);
          if (sup && sup.args.length) elemType = this.upperOf(sup.args[0]);
          else elemType = this.objectType;
          tree.iterableType = sup || this.syms.erasedType(iterSym);
        }
        tree.elemType = elemType;
        const v = tree.var;
        const vt = v.vartype ? this.resolveType(v.vartype, fenv) : this.types.upward(elemType);
        const sym = this.newLocal(v, vt, fenv);
        v.sym = sym;
        this.attribStat(tree.body, fenv.dup('block'));
        return;
      }
      case 'Labelled':
        this.attribStat(tree.body, env);
        return;
      case 'Switch': return this.attribSwitch(tree, env, false, null);
      case 'Synchronized':
        this.attribExpr(tree.lock, env, null);
        this.attribStat(tree.body, env.dup('block'));
        return;
      case 'Try': {
        const tenv = env.dup('block');
        for (const r of tree.resources) {
          if (r.tag === 'VarDecl') this.attribLocalVar(r, tenv);
          else this.attribExpr(r, tenv, null);
        }
        this.attribStat(tree.body, tenv.dup('block'));
        for (const c of tree.catchers) {
          const cenv = env.dup('block');
          const pt = this.resolveType(c.param.vartype, cenv);
          const sym = this.newLocal(c.param, pt, cenv);
          c.param.sym = sym;
          if (pt.kind === 'union') sym.flags |= F.FINAL;
          this.attribBlockStats(c.body.stats, cenv);
        }
        if (tree.finalizer) this.attribStat(tree.finalizer, env.dup('block'));
        return;
      }
      case 'Return': {
        if (tree.expr) {
          if (env.lambda && env.lambda.collectReturns) {
            const rt = env.lambda.returnType;
            const t = this.attribExpr(tree.expr, env, rt && rt.kind !== 'prim' ? rt : (rt && rt.tag !== 'void' ? rt : null));
            env.lambda.returnTypes.push(t);
            tree.expr.coerceTo = rt;
          } else {
            this.attribExprCoerce(tree.expr, env, env.returnType);
          }
        } else if (env.lambda && env.lambda.collectReturns) {
          env.lambda.voidReturn = true;
        }
        return;
      }
      case 'Throw':
        this.attribExpr(tree.expr, env, null);
        return;
      case 'Break': case 'Continue': case 'Skip':
        return;
      case 'Yield': {
        const target = this.findYieldTarget(env);
        if (!target) this.error('yield outside of switch expression', env, tree.pos);
        const t = this.attribExpr(tree.value, env, target.pt);
        target.types.push(t);
        target.values.push(tree.value);
        return;
      }
      case 'Assert':
        this.attribCond(tree.cond, env);
        if (tree.detail) this.attribExpr(tree.detail, env, null);
        return;
      default:
        this.error(`unexpected statement ${tree.tag}`, env, tree.pos);
    }
  }

  findYieldTarget(env) {
    for (let e = env; e; e = e.outer) {
      if (e.yieldTarget) return e.yieldTarget;
      if (e.kind === 'lambda' || e.kind === 'class') return null;
    }
    return null;
  }

  attribCond(tree, env) {
    const t = this.attribExpr(tree, env, PRIM.boolean);
    tree.coerceTo = PRIM.boolean;
    return t;
  }

  upperOf(a) {
    if (a.kind === 'wildcard') {
      if (a.bk === 'extends') return a.bound;
      return this.objectType;
    }
    return a;
  }

  newLocal(v, type, env) {
    const owner = env.method || env.info && env.info.csym;
    const sym = new VarSymbol(v.name, v.mods ? v.mods.flags & F.FINAL : 0, owner, type);
    sym.isLocal = true;
    sym.tree = v;
    sym.declEnv = env;
    sym.lambda = env.lambda;
    env.addLocal(sym);
    return sym;
  }

  attribLocalVar(tree, env) {
    let type;
    if (tree.vartype) {
      type = this.resolveType(tree.vartype, env);
      const sym = this.newLocal(tree, type, env);
      tree.sym = sym;
      if (tree.init) {
        if (tree.init.tag === 'NewArray' && !tree.init.elemtype && tree.init.dims.length === 0) this.attribArrayInit(tree.init, env, type);
        else this.attribExprCoerce(tree.init, env, type);
        if ((sym.flags & F.FINAL) && tree.init.constValue !== undefined && (type.kind === 'prim' || this.isString(type))) {
          sym.constValue = this.coerceConst(tree.init.constValue, tree.init.type, type);
        }
      }
      return;
    }
    // var: infer from initializer
    const sym = this.newLocal(tree, this.objectType, env);
    tree.sym = sym;
    env.scope.delete(tree.name); // not in scope within its own initializer
    const it = this.attribExpr(tree.init, env, null);
    let vt = it.kind === 'null' ? this.objectType : this.types.upward(it);
    if (vt.kind === 'intersection') vt = vt;
    sym.type = vt;
    env.addLocal(sym);
    tree.init.coerceTo = vt;
  }

  resolveType(tree, env) {
    return this.enter.resolveType(tree, env);
  }

  // ---- local and anonymous classes ------------------------------------------------
  allocLocalName(encl, name) {
    const base = encl.flatName;
    for (let i = 1; ; i++) {
      const n = `${base}$${i}${name}`;
      if (!this.syms.classes.has(n)) return n;
    }
  }

  attribLocalClassDecl(decl, env) {
    const encl = env.info && env.info.csym || env.clazz;
    const flat = this.allocLocalName(this.outermostNamedClass(env), decl.name);
    const sym = this.enter.enterLocalClass(decl, env, decl.name, flat);
    this.markPrologueClass(sym, env);
    env.addLocalClass(sym);
    this.enter.completeHeader(sym);
    this.attribClass(sym);
  }

  outermostNamedClass(env) {
    // javac names local classes after the immediately enclosing class
    return env.clazz;
  }

  // ---- expressions --------------------------------------------------------------
  // attribute with an assignment-context target type; records coerceTo
  attribExprCoerce(tree, env, target) {
    const t = this.attribExpr(tree, env, target);
    tree.coerceTo = target;
    return t;
  }

  attribExpr(tree, env, pt) {
    const t = this.attribTree(tree, env, pt);
    tree.type = t;
    return t;
  }

  attribTree(tree, env, pt) {
    switch (tree.tag) {
      case 'Literal': return this.attribLiteral(tree);
      case 'Parens': {
        const t = this.attribExpr(tree.expr, env, pt);
        tree.constValue = tree.expr.constValue;
        return t;
      }
      case 'Ident': return this.attribIdent(tree, env, pt);
      case 'Select': return this.attribSelect(tree, env, pt);
      case 'Apply': return this.attribApply(tree, env, pt);
      case 'NewClass': return this.attribNewClass(tree, env, pt);
      case 'NewArray': return this.attribNewArray(tree, env, pt);
      case 'Assign': {
        const lt = this.attribExpr(tree.lhs, env, null);
        if (tree.rhs.tag === 'NewArray' && !tree.rhs.elemtype && tree.rhs.dims.length === 0) this.attribArrayInit(tree.rhs, env, lt);
        else this.attribExprCoerce(tree.rhs, env, lt);
        return lt;
      }
      case 'AssignOp': return this.attribAssignOp(tree, env);
      case 'Unary': return this.attribUnary(tree, env);
      case 'Binary': return this.attribBinary(tree, env);
      case 'Conditional': return this.attribConditional(tree, env, pt);
      case 'TypeCast': return this.attribCast(tree, env);
      case 'InstanceOf': return this.attribInstanceOf(tree, env);
      case 'Indexed': {
        const at = this.attribExpr(tree.indexed, env, null);
        this.attribExprCoerce(tree.index, env, PRIM.int);
        const e = this.types.elemtype(at);
        if (!e) this.error(`array required, but ${T.typeToString(at)} found`, env, tree.pos);
        return this.types.capture(e);
      }
      case 'Lambda': return this.attribLambda(tree, env, pt);
      case 'Reference': return this.attribReference(tree, env, pt);
      case 'SwitchExpression': return this.attribSwitch(tree, env, true, pt);
      default:
        this.error(`unexpected expression ${tree.tag}`, env, tree.pos);
    }
    return null;
  }

  attribLiteral(tree) {
    switch (tree.typetag) {
      case 'int': tree.constValue = tree.value; return PRIM.int;
      case 'long': tree.constValue = tree.value; return PRIM.long;
      case 'float': tree.constValue = tree.value; return PRIM.float;
      case 'double': tree.constValue = tree.value; return PRIM.double;
      case 'char': tree.constValue = tree.value; return PRIM.char;
      case 'boolean': tree.constValue = tree.value; return PRIM.boolean;
      case 'String': tree.constValue = tree.value; return this.stringType;
      case 'null': return T.NULL;
      default: throw new Error(`bad literal ${tree.typetag}`);
    }
  }

  // ---- identifiers -----------------------------------------------------------------
  thisType(env) {
    const c = env.clazz;
    return this.enter.thisTypeOf(this.syms.completeHeader(c));
  }

  attribIdent(tree, env, pt) {
    const name = tree.name;
    if (name === 'this') {
      tree.sym = { kind: 'this', clazz: env.clazz };
      this.noteThisUse(env);
      return this.thisType(env);
    }
    if (name === 'super') {
      tree.sym = { kind: 'super', clazz: env.clazz };
      this.noteThisUse(env);
      return this.syms.completeHeader(env.clazz).superclass;
    }
    const v = this.rs.findVar(name, env);
    if (v) {
      const sym = v.sym;
      tree.sym = sym;
      if (v.kind === 'local') {
        this.noteLocalUse(sym, env);
        if (sym.constValue !== undefined && sym.constValue !== null && sym.constValue !== 'computing') tree.constValue = sym.constValue;
        return sym.type;
      }
      tree.fieldAccess = { envClass: v.envClass, outer: v.outer, staticImport: !!v.staticImport };
      if (!(sym.flags & F.STATIC)) {
        this.noteThisUse(env);
        if (v.outer) this.noteOuterUse(env, v.envClass);
      }
      const cv = this.constValueOf(sym);
      if (cv !== null && cv !== undefined) tree.constValue = cv;
      if (v.envClass && !(sym.flags & F.STATIC)) {
        const site = this.enter.thisTypeOf(v.envClass);
        return this.types.memberType(site, sym);
      }
      return sym.type;
    }
    const t = this.enter.findType(name, env);
    if (t) {
      tree.sym = t.kind === 'class' ? t.sym : t;
      tree.isType = true;
      return t;
    }
    if (this.syms.packageExists(name)) {
      tree.isPackage = true;
      tree.sym = this.syms.enterPackage(name);
      return new T.PackageType(tree.sym);
    }
    this.error(`cannot find symbol: ${name}`, env, tree.pos);
    return null;
  }

  noteThisUse(env) {
    if (env.lambda) env.lambda.usesThis = true;
  }

  noteOuterUse() {}

  noteLocalUse(sym, env) {
    // record captures for lambdas (local classes compute theirs in Lower)
    for (let e = env; e && e.lambda; ) {
      const lam = e.lambda;
      if (sym.lambda === lam) break;
      if (!lam.captured.includes(sym)) lam.captured.push(sym);
      // move to the env enclosing this lambda
      e = lam.outerEnv;
    }
  }

  // ---- selection ---------------------------------------------------------------------
  // Attribute the qualifier of a Select: expression, type or package.
  attribQualifier(tree, env) {
    const u = tree;
    if (u.tag === 'Ident') {
      if (u.name === 'this' || u.name === 'super') return this.attribExpr(u, env, null);
      const v = this.rs.findVar(u.name, env);
      if (v) return this.attribExpr(u, env, null);
      const t = this.enter.findType(u.name, env);
      if (t) {
        u.sym = t.kind === 'class' ? t.sym : t;
        u.isType = true;
        u.type = t;
        return t;
      }
      if (this.syms.packageExists(u.name)) {
        u.isPackage = true;
        u.sym = this.syms.enterPackage(u.name);
        u.type = new T.PackageType(u.sym);
        return u.type;
      }
      this.error(`cannot find symbol: ${u.name}`, env, u.pos);
    }
    if (u.tag === 'Select') {
      // could be package.Class, Class.Member, expr.field
      if (u.name !== 'class' && u.name !== 'this' && u.name !== 'super') {
        const q = this.attribQualifier(u.selected, env);
        const t = this.selectMember(u, q, env, null, true);
        u.type = t;
        return t;
      }
      return this.attribExpr(u, env, null);
    }
    if (u.tag === 'TypeApply' || u.tag === 'ArrayType' || u.tag === 'PrimitiveType' || u.tag === 'AnnotatedType') {
      const t = this.resolveType(u, env);
      u.isType = true;
      u.type = t;
      return t;
    }
    return this.attribExpr(u, env, null);
  }

  attribSelect(tree, env, pt) {
    const name = tree.name;
    if (name === 'class') {
      const t = this.resolveTypeOrExprType(tree.selected, env);
      tree.classLiteral = t;
      const boxed = t.kind === 'prim' ? this.types.boxedClass(t) : this.types.erasure(t);
      return new T.ClassType(this.syms.symOf('java.lang.Class'), [boxed], null);
    }
    if (name === 'this') {
      const t = this.resolveType(tree.selected, env);
      tree.outerThis = t.sym;
      this.noteThisUse(env);
      return this.enter.thisTypeOf(t.sym);
    }
    if (name === 'super') {
      // only valid as qualifier of a method call or field access; handled there
      const t = this.resolveType(tree.selected, env);
      tree.qualifiedSuper = t.sym;
      this.noteThisUse(env);
      if (t.sym.isInterface()) return t;
      return this.syms.completeHeader(t.sym).superclass;
    }
    const q = this.attribQualifier(tree.selected, env);
    return this.selectMember(tree, q, env, pt, false);
  }

  resolveTypeOrExprType(tree, env) {
    if (tree.tag === 'PrimitiveType' || tree.tag === 'ArrayType' || tree.tag === 'TypeApply') return this.resolveType(tree, env);
    if (tree.tag === 'Ident' || tree.tag === 'Select') {
      const t = this.enter.resolveTypeOrPackage(tree, env);
      if (t && t.kind !== 'package') return t;
    }
    return this.resolveType(tree, env);
  }

  // tree is a Select whose qualifier has type/kind q
  selectMember(tree, q, env, pt, asQualifier) {
    const name = tree.name;
    const sel = tree.selected;
    if (q.kind === 'package') {
      const c = this.syms.findTopLevel(q.sym.fullName, name);
      if (c) {
        tree.sym = c;
        tree.isType = true;
        tree.type = this.syms.erasedType(c);
        return tree.type;
      }
      const pn = `${q.sym.fullName}.${name}`;
      if (this.syms.packageExists(pn)) {
        tree.isPackage = true;
        tree.sym = this.syms.enterPackage(pn);
        tree.type = new T.PackageType(tree.sym);
        return tree.type;
      }
      this.error(`cannot find symbol: ${pn}`, env, tree.pos);
    }
    const qualIsType = sel.isType || (sel.tag === 'Select' && sel.name === 'super' && false);
    if (q.kind === 'array' && name === 'length' && !qualIsType) {
      tree.arrayLength = true;
      return PRIM.int;
    }
    // field
    const f = this.rs.findFieldInType(q, name);
    if (f) {
      tree.sym = f;
      if (qualIsType) tree.staticRef = true;
      const cv = this.constValueOf(f);
      if (cv !== null && cv !== undefined) tree.constValue = cv;
      if (f.flags & F.STATIC) return f.type;
      const site = q.kind === 'class' || q.kind === 'tvar' || q.kind === 'intersection' ? this.types.capture(q) : q;
      return this.types.memberType(site, f);
    }
    // member type
    if (q.kind === 'class' || q.kind === 'tvar') {
      const cs = q.kind === 'class' ? q.sym : this.types.erasure(q).sym;
      const c = this.enter.findMemberType(cs, name);
      if (c) {
        tree.sym = c;
        tree.isType = true;
        tree.type = this.enter.memberClassType(q, c);
        return tree.type;
      }
    }
    this.error(`cannot find symbol: ${name} in ${T.typeToString(q)}`, env, tree.pos);
    return null;
  }

  // ---- method invocation ------------------------------------------------------------
  // Describe arguments: attribute standalone ones, classify poly ones.
  attribArgs(args, env) {
    return args.map((a) => this.argInfo(a, env));
  }

  argInfo(a, env) {
    const u = unparen(a);
    if (u.tag === 'Lambda') {
      const info = { tree: a, poly: 'lambda', arity: u.params.length, explicit: u.paramKind === 'explicit' };
      const shape = this.lambdaShape(u);
      info.voidCompatible = shape.voidCompatible;
      info.valueCompatible = shape.valueCompatible;
      return info;
    }
    if (u.tag === 'Reference') return { tree: a, poly: 'mref', arityOk: this.mrefArityTest(u, env) };
    if (u.tag === 'Conditional' && (this.isPolyBranch(u.truepart) || this.isPolyBranch(u.falsepart))) {
      const branches = [u.truepart, u.falsepart].filter((b) => this.isPolyBranch(b)).map((b) => this.argInfoShallow(b));
      return { tree: a, poly: 'cond', branches };
    }
    if (u.tag === 'SwitchExpression' && this.switchHasPolyArms(u)) {
      return { tree: a, poly: 'switch' };
    }
    if (this.isDeferrableInvocation(u)) {
      // a nested invocation whose lambdas/method refs may need our target type:
      // attribute it once the enclosing method is instantiated
      const info = { tree: a, poly: 'invocation', env };
      const e = this.deferredErasure(info);
      // generic results (type variables) erase to their bounds and say little
      if (e && !(e.kind === 'class' && this.types.isObject(e))) info.erasedType = e;
      return info;
    }
    const t = this.attribExpr(a, env, null);
    return { tree: a, type: t, poly: null };
  }

  // JLS 15.12.2.1: a method reference is potentially compatible with a
  // function type of arity n if some method of that name could take n
  // arguments (or n-1 with an unbound receiver). Returns a predicate or null.
  mrefArityTest(u, env) {
    try {
      const e = u.expr;
      let qualType;
      let qualIsType = false;
      if (e.tag === 'Ident' && e.name === 'super') return null;
      if (e.tag === 'Select' && e.name === 'super') return null;
      if (e.tag === 'ArrayType' || e.tag === 'PrimitiveType' || e.tag === 'TypeApply') {
        qualType = this.resolveType(e, env);
        qualIsType = true;
      } else if (e.tag === 'Ident' || e.tag === 'Select') {
        let head = e;
        while (head.tag === 'Select') head = head.selected;
        const headIsVar = head.tag === 'Ident' && (head.name === 'this' || this.rs.findVar(head.name, env));
        if (!headIsVar) {
          const t = this.enter.resolveTypeOrPackage(e, env);
          if (t && t.kind !== 'package') { qualType = t; qualIsType = true; }
        }
        if (!qualType) return null;
      } else return null;
      if (u.mode === 'new') {
        if (qualType.kind === 'array') return (n) => n === 1;
        const cs = this.syms.completeMembers(qualType.sym);
        const ctors = cs.getMembers('<init>').filter((m) => m.kind === 'method');
        return (n) => ctors.some((m) => m.params.length === n || ((m.flags & F.VARARGS) && n >= m.params.length - 1));
      }
      const ms = this.rs.methodsInSite(qualType, u.name).map((c) => c.sym);
      if (!ms.length) return null;
      return (n) => ms.some((m) => {
        const k = m.params.length;
        const va = (m.flags & F.VARARGS) !== 0;
        const fits = (x) => x === k || (va && x >= k - 1);
        if (fits(n)) return true;
        return qualIsType && !(m.flags & F.STATIC) && fits(n - 1);
      });
    } catch (err) {
      return null;
    }
  }

  // Method invocations and diamond instance creations in argument position
  // are attributed after the enclosing method is chosen, so they can use its
  // instantiated formal as target type (JLS 15.12, poly expressions).
  isDeferrableInvocation(u) {
    if (u.tag === 'Apply') {
      const m = u.meth;
      if (m.tag === 'Ident' && (m.name === 'this' || m.name === 'super')) return false;
      return true;
    }
    if (u.tag === 'NewClass') {
      let c = u.clazz;
      while (c.tag === 'AnnotatedType') c = c.underlying;
      const diamond = c.tag === 'TypeApply' && c.args.length === 0;
      if (u.body) return diamond;
      return diamond || this.hasPolyArgs(u);
    }
    return false;
  }

  hasPolyArgs(u) {
    return u.args.some((x) => {
      const v = unparen(x);
      if (this.isPolyBranch(v)) return true;
      if ((v.tag === 'Apply' || v.tag === 'NewClass') && !v.body) return this.hasPolyArgs(v);
      return false;
    });
  }

  // Attribute deferred invocation arguments standalone (no target type).
  // Instance creations keep their target: their erased class type is enough
  // to choose among overloads.
  forceDeferred(args) {
    for (const a of args) {
      if (a.poly !== 'invocation') continue;
      const u = unparen(a.tree);
      if (u.tag === 'NewClass' && !u.encl) {
        try {
          let c = u.clazz;
          while (c.tag === 'AnnotatedType') c = c.underlying;
          const t = this.resolveType(c.tag === 'TypeApply' ? c.clazz : c, a.env);
          a.erasedType = this.types.erasure(t);
          continue;
        } catch (e) { /* fall back to standalone attribution */ }
      }
      a.type = this.attribExpr(a.tree, a.env, null);
      a.poly = null;
    }
  }

  // The erased type of a deferred method invocation, when all candidates of
  // the right arity agree on it; used for applicability so that, e.g., a
  // single element passed to a varargs method is not taken for the array.
  deferredErasure(a) {
    const u = unparen(a.tree);
    if (u.tag === 'NewClass') {
      if (u.encl) return null;
      let c = u.clazz;
      while (c.tag === 'AnnotatedType') c = c.underlying;
      try { return this.types.erasure(this.resolveType(c.tag === 'TypeApply' ? c.clazz : c, a.env)); } catch (e) { return null; }
    }
    if (u.tag !== 'Apply') return null;
    const meth = u.meth;
    let cands;
    let site = null;
    try {
      if (meth.tag === 'Ident') {
        let found = null;
        for (let e = a.env; e; e = e.outer) {
          if (e.kind === 'class' && e.clazz && this.rs.hasMethodNamed(e.clazz, meth.name)) { found = e.clazz; break; }
        }
        if (found) site = this.enter.thisTypeOf(this.syms.completeHeader(found));
        cands = found ? this.rs.methodsInSite(site, meth.name) : this.staticImportedMethods(meth.name, a.env);
      } else if (meth.tag === 'Select') {
        const sel = meth.selected;
        if (sel.tag === 'Ident' && sel.name === 'super') {
          site = this.syms.completeHeader(a.env.clazz).superclass;
          cands = this.rs.methodsInSite(site, meth.name);
        } else if (sel.tag === 'Select' && sel.name === 'super') return null;
        else {
          const q = this.attribQualifier(sel, a.env);
          if (!q || q.kind === 'package') return null;
          site = q;
          cands = this.rs.methodsInSite(q, meth.name);
        }
      } else return null;
    } catch (e) {
      return null;
    }
    const n = u.args.length;
    const fitting = cands.filter((c) => c.sym.params.length === n || ((c.sym.flags & F.VARARGS) && n >= c.sym.params.length - 1));
    if (!fitting.length) return null;
    const rets = [];
    for (const c of fitting) {
      const m = c.sym;
      // a result built from the method's own type variables depends on inference
      if (m.type.typarams.length && this.rs.mentions(m.type.ret, m.type.typarams)) return null;
      let rt = m.type.ret;
      if (site && !(m.flags & F.STATIC) && site.kind !== 'array') {
        try { rt = this.types.memberType(this.types.capture(site), m).ret; } catch (e) { return null; }
      }
      if (rt.kind === 'tvar') return null;
      rets.push(this.types.erasure(rt));
    }
    if (rets.every((r) => this.types.isSameType(r, rets[0]))) return rets[0];
    return null;
  }

  isPolyBranch(t) {
    const u = unparen(t);
    if (u.tag === 'Lambda' || u.tag === 'Reference') return true;
    if (u.tag === 'Conditional') return this.isPolyBranch(u.truepart) || this.isPolyBranch(u.falsepart);
    return false;
  }

  argInfoShallow(t) {
    const u = unparen(t);
    if (u.tag === 'Lambda') {
      const s = this.lambdaShape(u);
      return { tree: t, poly: 'lambda', arity: u.params.length, voidCompatible: s.voidCompatible, valueCompatible: s.valueCompatible };
    }
    if (u.tag === 'Reference') return { tree: t, poly: 'mref' };
    const branches = [u.truepart, u.falsepart].filter((b) => this.isPolyBranch(b)).map((b) => this.argInfoShallow(b));
    return { tree: t, poly: 'cond', branches };
  }

  switchHasPolyArms(sw) {
    for (const c of sw.cases) {
      if (c.arrow && c.body && c.body.tag === 'Exec' && this.isPolyBranch(c.body.expr)) return true;
    }
    return false;
  }

  // void/value compatibility of a lambda body (JLS 15.27.2)
  lambdaShape(lam) {
    if (lam.body.tag !== 'Block') {
      const e = unparen(lam.body);
      const stmtExpr = ['Apply', 'NewClass', 'Assign', 'AssignOp'].includes(e.tag) || (e.tag === 'Unary' && /^(pre|post)/.test(e.op));
      return { voidCompatible: stmtExpr, valueCompatible: true };
    }
    let hasValueReturn = false;
    let hasVoidReturn = false;
    const visit = (s) => {
      switch (s.tag) {
        case 'Return': if (s.expr) hasValueReturn = true; else hasVoidReturn = true; return;
        case 'Lambda': case 'ClassDecl': case 'ClassDef': return;
        case 'NewClass': s.args.forEach(visit); if (s.encl) visit(s.encl); return;
        default: forEachChild(s, visit);
      }
    };
    lam.body.stats.forEach(visit);
    const canComplete = this.canCompleteNormally(lam.body);
    const valueCompatible = !hasVoidReturn && (!canComplete);
    const voidCompatible = !hasValueReturn;
    return { voidCompatible, valueCompatible: valueCompatible || (!hasVoidReturn && hasValueReturn) };
  }

  // conservative "can complete normally" for a lambda block body
  canCompleteNormally(block) {
    const stats = block.stats;
    if (!stats.length) return true;
    const last = stats[stats.length - 1];
    return this.stmtCanComplete(last);
  }

  stmtCanComplete(s) {
    switch (s.tag) {
      case 'Return': case 'Throw': return false;
      case 'Block': return s.stats.length === 0 || this.stmtCanComplete(s.stats[s.stats.length - 1]);
      case 'If': return !s.elsep || this.stmtCanComplete(s.thenp) || this.stmtCanComplete(s.elsep);
      case 'WhileLoop': {
        const c = unparen(s.cond);
        if (c.tag === 'Literal' && c.value === true) return this.containsBreak(s.body);
        return true;
      }
      case 'DoLoop': return true;
      case 'ForLoop': return s.cond !== null || this.containsBreak(s.body);
      case 'Try':
        if (s.finalizer && !this.stmtCanComplete(s.finalizer)) return false;
        return this.stmtCanComplete(s.body) || s.catchers.some((c) => this.stmtCanComplete(c.body));
      case 'Synchronized': return this.stmtCanComplete(s.body);
      case 'Switch': return true;
      case 'Labelled': return true;
      default: return true;
    }
  }

  containsBreak(s) {
    let found = false;
    const visit = (n, depth) => {
      if (found) return;
      if (n.tag === 'Break' && (!n.label ? depth === 0 : true)) { found = true; return; }
      if (n.tag === 'Lambda' || n.tag === 'ClassDecl' || n.tag === 'ClassDef') return;
      const loop = ['WhileLoop', 'DoLoop', 'ForLoop', 'ForeachLoop', 'Switch'].includes(n.tag);
      forEachChild(n, (c) => visit(c, loop ? depth + 1 : depth));
    };
    visit(s, 0);
    return found;
  }

  attribApply(tree, env, pt) {
    const meth = tree.meth;
    // constructor calls this(...) / super(...)
    if (meth.tag === 'Ident' && (meth.name === 'this' || meth.name === 'super')) return this.attribCtorCall(tree, env, meth.name);
    if (meth.tag === 'Select' && meth.name === 'super' ) return this.attribCtorCall(tree, env, 'super', meth.selected);
    const args = this.attribArgs(tree.args, env);
    const typeargs = tree.typeargs.map((t) => this.resolveType(t, env));
    let site;
    let candidates;
    let name;
    if (meth.tag === 'Ident') {
      name = meth.name;
      // innermost enclosing class with a member method of this name (JLS 15.12.1)
      let found = null;
      let outer = false;
      for (let e = env; e; e = e.outer) {
        if (e.kind === 'class' && e.clazz) {
          if (this.rs.hasMethodNamed(e.clazz, name)) { found = e.clazz; break; }
          outer = true;
        }
      }
      if (found) {
        site = this.enter.thisTypeOf(this.syms.completeHeader(found));
        candidates = this.rs.methodsInSite(site, name);
        tree.receiver = { kind: outer ? 'outer' : 'this', clazz: found };
      } else {
        // static imports
        candidates = this.staticImportedMethods(name, env);
        tree.receiver = { kind: 'static' };
        site = null;
      }
    } else if (meth.tag === 'Select') {
      name = meth.name;
      const sel = meth.selected;
      if (sel.tag === 'Ident' && sel.name === 'super') {
        const sup = this.syms.completeHeader(env.clazz).superclass;
        site = sup;
        sel.type = sup;
        sel.sym = { kind: 'super', clazz: env.clazz };
        this.noteThisUse(env);
        candidates = this.rs.methodsInSite(site, name);
        // a super call may also target a default method of a direct superinterface? no: Iface.super
        tree.receiver = { kind: 'super', clazz: env.clazz };
      } else if (sel.tag === 'Select' && sel.name === 'super') {
        const q = this.resolveType(sel.selected, env);
        this.noteThisUse(env);
        if (q.sym.isInterface()) {
          site = q;
          tree.receiver = { kind: 'ifaceSuper', iface: q.sym, clazz: env.clazz };
        } else {
          site = this.syms.completeHeader(q.sym).superclass;
          tree.receiver = { kind: 'outerSuper', clazz: q.sym };
        }
        sel.type = site;
        candidates = this.rs.methodsInSite(site, name);
      } else {
        const q = this.attribQualifier(sel, env);
        if (q.kind === 'package') this.error(`cannot call a method on a package`, env, meth.pos);
        site = q;
        candidates = this.rs.methodsInSite(q.kind === 'class' || q.kind === 'tvar' || q.kind === 'intersection' ? q : q, name);
        tree.receiver = { kind: sel.isType ? 'static' : 'expr' };
      }
    } else {
      this.error('bad method call', env, tree.pos);
    }
    if (!candidates.length) this.error(`cannot find symbol: method ${name}`, env, tree.pos);
    this.forceDeferredIfOverloaded(candidates, args);
    const res = this.rs.selectMethod(site, candidates, args, typeargs, env.clazz);
    if (!res) {
      this.error(`no suitable method found for ${name}(${args.map((a) => (a.type ? T.typeToString(a.type) : a.poly)).join(',')})${site ? ' in ' + T.typeToString(site) : ''}`, env, tree.pos);
    }
    const msym = res.sym;
    meth.sym = msym;
    tree.sym = msym;
    tree.varargs = res.varargs;
    if (res.candidate && res.candidate.arrayClone) tree.arrayClone = true;
    if (tree.receiver.kind === 'this' || tree.receiver.kind === 'outer') {
      if (msym.flags & F.STATIC) tree.receiver.kind = 'static';
      else this.noteThisUse(env);
    }
    let mtype = this.instantiate(res, args, pt, env, site, typeargs);
    // getClass() has type Class<? extends |T|>
    if (msym.name === 'getClass' && msym.params.length === 0 && msym.owner === this.syms.objectSym) {
      const recv = site || this.thisType(env);
      mtype = new T.MethodType([], new T.ClassType(this.syms.symOf('java.lang.Class'), [new T.WildcardType('extends', this.types.erasure(recv))], null), [], []);
    }
    tree.mtype = mtype;
    this.finishArgs(tree.args, args, mtype, res.varargs, env);
    let rt = mtype.ret;
    if (rt.kind === 'class' || rt.kind === 'tvar') rt = this.types.capture(rt);
    return rt;
  }

  forceDeferredIfOverloaded(candidates, args) {
    if (!args.some((a) => a.poly === 'invocation')) return;
    const n = args.length;
    const fitting = candidates.filter((c) => {
      const k = c.sym.params.length;
      return k === n || ((c.sym.flags & F.VARARGS) && n >= k - 1);
    });
    if (fitting.length > 1) this.forceDeferred(args);
  }

  staticImportedMethods(name, env) {
    let u = env;
    while (u && u.kind !== 'unit') u = u.outer;
    if (!u) return [];
    const out = [];
    for (const si of u.unit.staticSingle) {
      if (si.name !== name) continue;
      const owner = this.syms.findClassByName(si.owner);
      if (!owner) continue;
      for (const m of this.rs.collectMethods(owner, name)) if (m.flags & F.STATIC) out.push({ sym: m });
    }
    if (out.length) return out;
    for (const q of u.unit.staticOnDemand) {
      const owner = this.syms.findClassByName(q);
      if (!owner) continue;
      for (const m of this.rs.collectMethods(owner, name)) if (m.flags & F.STATIC) out.push({ sym: m });
    }
    return out;
  }

  // Instantiate a selected method: infer type variables if generic, attribute
  // poly arguments (lambdas, method refs) against the instantiated formals.
  instantiate(res, args, pt, env, site, typeargs, extraVars) {
    let mtype = res.mtype;
    const vars = (mtype.typarams || []).concat(extraVars || []);
    if (!vars.length) {
      this.attribPolyArgs(args, mtype, res.varargs, env, null);
      return mtype;
    }
    const ctx = new InferenceContext(this.types, this.syms, vars);
    const formals = mtype.params.map((p) => ctx.asUndet(p));
    const ret = ctx.asUndet(mtype.ret);
    const formalAt = (i) => {
      if (res.varargs && i >= formals.length - 1) return this.types.elemtype(formals[formals.length - 1]) || formals[formals.length - 1];
      return formals[i];
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.poly) ctx.compatible(a.type, formalAt(i));
    }
    // target type (assignment or invocation context) for still-unconstrained variables
    if (pt && pt.kind !== 'prim' && !(pt.kind === 'class' && this.types.isObject(pt))) {
      const unconstrained = ctx.ivars.map((_, i) => i).filter((i) => !ctx.eq[i].length && !ctx.lower[i].length);
      if (unconstrained.length && !ctx.isProper(ret)) {
        ctx.compatible(ret, pt);
      }
    } else if (pt && pt.kind === 'prim' && ctx.idx(ret) >= 0) {
      const i = ctx.idx(ret);
      if (!ctx.eq[i].length && !ctx.lower[i].length) ctx.addBound(ctx.lower, i, this.types.boxedClass(pt));
    }
    // poly args, in dependency order: an argument is processed once the
    // variables it reads (lambda parameter types) and the variables that
    // bound its outputs are known
    const pending = [];
    for (let i = 0; i < args.length; i++) if (args[i].poly) pending.push(i);
    while (pending.length) {
      let k = pending.findIndex((i) => this.polyArgReady(args[i], formalAt(i), ctx));
      if (k < 0) k = 0;
      const i = pending.splice(k, 1)[0];
      this.inferPolyArg(args[i], formalAt(i), ctx, env, ret, pt);
    }
    const inst = ctx.resolve();
    const decl = vars;
    const full = this.types.subst(mtype, decl, inst);
    full.typarams = [];
    if (!mtype.typarams.length && extraVars) full.typarams = [];
    res.inst = inst;
    res.ctx = ctx;
    return full;
  }

  polyArgReady(a, formal, ctx) {
    const known = (i) => !!ctx.inst[i] || ctx.eq[i].length > 0 || ctx.lower[i].length > 0;
    const mentioned = [];
    this.collectIvars(formal, ctx, mentioned);
    const inputs = [];
    if (a.poly === 'lambda' || a.poly === 'mref') {
      const fnRaw = this.types.erasure(formal).kind === 'class' ? this.rs.functionType(formal) : null;
      if (fnRaw) for (const p of fnRaw.type.params) this.collectIvars(p, ctx, inputs);
    }
    if (inputs.some((i) => !known(i) && !ctx.upper[i].some((b) => !this.types.isObject(b) && ctx.isProper(ctx.substInst(b))))) return false;
    // outputs whose declared bounds mention other unknown variables must wait
    for (const i of mentioned) {
      if (inputs.includes(i) || known(i)) continue;
      const deps = [];
      for (const b of ctx.ivars[i].bounds || []) this.collectIvars(b, ctx, deps);
      if (deps.some((d) => d !== i && !known(d))) return false;
    }
    return true;
  }

  // Attribute lambda/mref arguments of a non-generic invocation.
  attribPolyArgs(args, mtype, varargs, env) {
    const n = mtype.params.length;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.poly) continue;
      let formal = varargs && i >= n - 1 ? this.types.elemtype(mtype.params[n - 1]) || mtype.params[n - 1] : mtype.params[i];
      this.attribPolyWithTarget(a.tree, env, formal);
    }
  }

  attribPolyWithTarget(tree, env, target) {
    const u = unparen(tree);
    if (u.done) return;
    this.attribExpr(tree, env, target);
    tree.coerceTo = target;
  }

  inferPolyArg(a, formal, ctx, env, ret, pt) {
    const u = unparen(a.tree);
    if (a.poly === 'invocation') {
      // Target for a deferred call: variables of the formal that already have
      // bounds are resolved, still unconstrained ones become wildcards. The
      // call's type is fed back as a constraint afterwards.
      // Only equality bounds fix a variable here; variables with just lower
      // bounds stay open so the call's own type can still widen them.
      const mentioned = [];
      this.collectIvars(formal, ctx, mentioned);
      const known = [];
      const vals = [];
      const lowerOnly = new Map(); // ivar -> lub of its lower bounds
      for (const i of mentioned) {
        if (ctx.inst[i]) { known.push(ctx.ivars[i]); vals.push(ctx.inst[i]); continue; }
        const eqs = ctx.eq[i].map((b) => ctx.substInst(b)).filter((b) => ctx.isProper(b));
        if (eqs.length) { known.push(ctx.ivars[i]); vals.push(eqs[0]); continue; }
        const lows = ctx.lower[i].map((b) => ctx.substInst(b)).filter((b) => ctx.isProper(b));
        if (lows.length) lowerOnly.set(ctx.ivars[i], lows.length === 1 ? lows[0] : this.types.lub(lows));
      }
      let target = this.types.subst(formal, known, vals);
      if (!ctx.isProper(target)) target = this.wildcardUnresolved(target, ctx, lowerOnly);
      const t = this.attribExpr(a.tree, env, target);
      a.tree.coerceTo = formal;
      a.type = t;
      ctx.compatible(t, formal);
      a.lateTarget = { formal, ctx };
      return;
    }
    if (a.poly === 'cond' || a.poly === 'switch') {
      // attribute after resolution with the instantiated formal
      ctx.resolve();
      const f = ctx.substInst(formal);
      this.attribPolyWithTarget(a.tree, env, f);
      return;
    }
    if (formal.kind === 'tvar' && ctx.idx(formal) >= 0) {
      // target is an inference variable itself: needs the bound or pt
      ctx.resolve();
      const f = ctx.substInst(formal);
      this.attribPolyWithTarget(a.tree, env, f);
      return;
    }
    // input variables: those mentioned in the function type's parameter types
    const fe = this.types.erasure(formal);
    if (fe.kind !== 'class') return;
    const fnSym = this.rs.findFunctionalMethod(fe.sym);
    if (!fnSym) return;
    const fnRaw = this.rs.functionType(formal);
    const inputIdx = [];
    if (fnRaw) {
      for (const p of fnRaw.type.params) this.collectIvars(p, ctx, inputIdx);
      if (a.poly === 'mref' && u.expr && false) { /* receiver inference not needed */ }
    }
    // explicitly typed lambdas give equality constraints on the parameter types
    if (a.poly === 'lambda' && u.paramKind === 'explicit' && fnRaw) {
      u.params.forEach((p, k) => {
        if (k < fnRaw.type.params.length) ctx.equal(this.resolveType(p.vartype, env), fnRaw.type.params[k], 0);
      });
    }
    if (a.poly === 'mref' && fnRaw) this.exactMrefConstraints(u, fnRaw, ctx, env);
    if (inputIdx.length) {
      // resolve inputs (do not force those without bounds yet if they also appear in the return)
      ctx.resolve(inputIdx);
    }
    const target = ctx.substInst(formal);
    // attribute the lambda/mref with its (partially) instantiated target
    if (a.poly === 'lambda') {
      const lamTarget = this.properOrBound(target, ctx);
      const fn = this.rs.functionType(lamTarget);
      const rtUndet = fnRaw ? fnRaw.type.ret : null;
      this.attribLambdaWith(u, env, lamTarget, fn, true);
      u.done = true;
      a.tree.type = lamTarget;
      if (a.tree !== u) a.tree.type = lamTarget;
      a.tree.coerceTo = lamTarget;
      if (rtUndet && !(rtUndet.kind === 'prim' && rtUndet.tag === 'void')) {
        for (const r of u.returnTypes || []) if (r && r.kind !== 'null') ctx.compatible(r, rtUndet);
      }
      // the final target may differ once the outputs are known: fix after resolution
      a.lateTarget = { formal, ctx };
    } else if (a.poly === 'mref') {
      const mrefTarget = this.properOrBound(target, ctx);
      this.attribExpr(u, env, mrefTarget);
      u.done = true;
      a.tree.type = mrefTarget;
      a.tree.coerceTo = mrefTarget;
      const rtUndet = fnRaw ? fnRaw.type.ret : null;
      if (rtUndet && !(rtUndet.kind === 'prim' && rtUndet.tag === 'void') && u.refReturnType) {
        ctx.compatible(u.refReturnType, rtUndet);
      }
      a.lateTarget = { formal, ctx };
    }
  }

  // JLS 15.13.1 / 18.2.1: an exact method reference (the qualifier type has a
  // single, non-generic, non-varargs method of that name) constrains the
  // function type's parameter and return types.
  exactMrefConstraints(u, fnRaw, ctx, env) {
    if (u.mode !== 'invoke' || u.typeargs.length) return;
    const e = u.expr;
    let qualType = null;
    let qualIsType = false;
    try {
      if (e.tag === 'Ident' && e.name !== 'this' && e.name !== 'super' && !this.rs.findVar(e.name, env)) {
        const t = this.enter.findType(e.name, env);
        if (t) { qualType = t; qualIsType = true; }
      } else if (e.tag === 'Select' && e.name !== 'super' && e.name !== 'this' && e.name !== 'class') {
        const t = this.enter.resolveTypeOrPackage(e, env);
        if (t && t.kind !== 'package') {
          // Select could also be a field access; only treat as type when the head is not a variable
          let head = e;
          while (head.tag === 'Select') head = head.selected;
          if (!(head.tag === 'Ident' && this.rs.findVar(head.name, env))) { qualType = t; qualIsType = true; }
        }
      } else if (e.tag === 'TypeApply' || e.tag === 'ArrayType') {
        qualType = this.resolveType(e, env);
        qualIsType = true;
      }
    } catch (err) { return; }
    if (!qualIsType || !qualType || qualType.kind !== 'class') return;
    const ms = this.rs.methodsInSite(qualType, u.name);
    if (ms.length !== 1) return;
    const m = ms[0].sym;
    if (m.type.typarams.length || (m.flags & F.VARARGS)) return;
    const P = fnRaw.type.params;
    const site = qualType.args.length === 0 && qualType.sym.typarams && qualType.sym.typarams.length ? null : qualType;
    const mt = site ? this.types.memberType(site, m) : m.type;
    const Fs = mt.params;
    if (m.flags & F.STATIC) {
      if (P.length !== Fs.length) return;
      P.forEach((p, i) => ctx.compatible(p, Fs[i]));
    } else {
      if (P.length !== Fs.length + 1) return;
      ctx.subtype(P[0], site ? qualType : this.types.erasure(qualType), 0);
      for (let i = 1; i < P.length; i++) ctx.compatible(P[i], Fs[i - 1]);
    }
    const R = fnRaw.type.ret;
    if (site && !(R.kind === 'prim' && R.tag === 'void')) ctx.compatible(mt.ret, R);
  }

  // replace unresolved inference variables occurring as type arguments by
  // unbounded wildcards; a bare unresolved variable yields null (no target)
  wildcardUnresolved(t, ctx, lowerOnly) {
    const go = (u, asArg) => {
      if (!u) return u;
      switch (u.kind) {
        case 'tvar':
          if (ctx.idx(u) < 0) return u;
          if (!asArg) return null;
          // a variable known to be at least L is still open: ? extends L
          if (lowerOnly && lowerOnly.has(u)) return new T.WildcardType('extends', lowerOnly.get(u));
          return new T.WildcardType('unbound', null);
        case 'class': {
          const args = u.args.map((x) => go(x, true));
          if (args.some((x) => x === null)) return null;
          return new T.ClassType(u.sym, args, u.outer);
        }
        case 'wildcard': {
          if (!u.bound) return u;
          if (u.bound.kind === 'tvar' && ctx.idx(u.bound) >= 0) return new T.WildcardType('unbound', null);
          const b = go(u.bound, false);
          return b ? new T.WildcardType(u.bk, b) : new T.WildcardType('unbound', null);
        }
        case 'array': {
          const e = go(u.elem, false);
          return e ? new T.ArrayType(e) : null;
        }
        default: return u;
      }
    };
    return go(t, false);
  }

  // replace unresolved inference variables by provisional resolutions
  properOrBound(t, ctx) {
    if (ctx.isProper(t)) return t;
    const tmp = ctx.inst.slice();
    const visiting = new Set();
    const prov = (i) => {
      if (tmp[i]) return tmp[i];
      if (visiting.has(i)) return null;
      visiting.add(i);
      // resolve the variables this one's bounds depend on first
      const deps = [];
      for (const b of ctx.upper[i]) this.collectIvars(b, ctx, deps);
      for (const b of ctx.eq[i].concat(ctx.lower[i])) this.collectIvars(b, ctx, deps);
      for (const d of deps) if (d !== i) prov(d);
      const known = [];
      const vals = [];
      for (let k = 0; k < ctx.ivars.length; k++) if (tmp[k]) { known.push(ctx.ivars[k]); vals.push(tmp[k]); }
      const sub = (x) => this.types.subst(x, known, vals);
      const proper = (list) => list.map(sub).filter((x) => ctx.isProper(x));
      let r = null;
      const eqs = proper(ctx.eq[i]);
      const lows = proper(ctx.lower[i]);
      if (eqs.length) r = eqs[0];
      else if (lows.length) r = lows.length === 1 ? lows[0] : this.types.lub(lows);
      else {
        const ups = proper(ctx.upper[i]).filter((u) => !this.types.isObject(u));
        if (ups.length) r = ups.reduce((a, b) => this.types.glb(a, b));
        else r = this.objectType;
      }
      tmp[i] = r;
      return r;
    };
    const mentioned = [];
    this.collectIvars(t, ctx, mentioned);
    for (const i of mentioned) prov(i);
    const known = [];
    const vals = [];
    for (let i = 0; i < ctx.ivars.length; i++) if (tmp[i]) { known.push(ctx.ivars[i]); vals.push(tmp[i]); }
    return this.types.subst(t, known, vals);
  }

  collectIvars(t, ctx, out) {
    if (!t) return;
    switch (t.kind) {
      case 'tvar': { const i = ctx.idx(t); if (i >= 0 && !out.includes(i)) out.push(i); return; }
      case 'class': t.args.forEach((a) => this.collectIvars(a, ctx, out)); if (t.outer) this.collectIvars(t.outer, ctx, out); return;
      case 'array': this.collectIvars(t.elem, ctx, out); return;
      case 'wildcard': if (t.bound) this.collectIvars(t.bound, ctx, out); return;
      case 'intersection': t.bounds.forEach((b) => this.collectIvars(b, ctx, out)); return;
      default: return;
    }
  }

  // Record argument coercion targets once the method type is known.
  finishArgs(argTrees, args, mtype, varargs, env) {
    const n = mtype.params.length;
    for (let i = 0; i < argTrees.length; i++) {
      const formal = varargs && i >= n - 1 ? this.types.elemtype(mtype.params[n - 1]) || mtype.params[n - 1] : mtype.params[i];
      const a = args[i];
      if (a.poly) {
        const u = unparen(a.tree);
        if (!u.done && !u.type) this.attribPolyWithTarget(a.tree, env, formal);
        if (a.lateTarget) {
          // the final instantiated target type (outputs now known)
          a.tree.coerceTo = formal;
          u.finalTarget = formal;
        }
        if (!a.tree.coerceTo) a.tree.coerceTo = formal;
        continue;
      }
      argTrees[i].coerceTo = formal;
    }
  }

  // ---- constructors ------------------------------------------------------------------
  attribCtorCall(tree, env, which, qualifier) {
    const csym = env.clazz;
    const args = this.attribArgs(tree.args, env);
    let site;
    if (which === 'this') site = this.enter.thisTypeOf(csym);
    else {
      site = this.syms.completeHeader(csym).superclass;
      if (qualifier) {
        tree.outerInstance = qualifier;
        this.attribExpr(qualifier, env, null);
      }
    }
    // arguments of this()/super() are in a static-like context (no this use), but
    // they may use outer instances
    const res = this.resolveConstructor(env, site, args, tree.typeargs.map((t) => this.resolveType(t, env)), tree.pos);
    tree.sym = res.sym;
    tree.meth.sym = res.sym;
    tree.mtype = res.mtype;
    tree.varargs = res.varargs;
    tree.ctorCall = which;
    this.finishArgs(tree.args, args, res.mtype, res.varargs, env);
    return PRIM.void;
  }

  resolveConstructor(env, site, args, typeargs, pos, pt, diamond) {
    const csym = site.sym;
    this.syms.completeMembers(csym);
    const ctors = csym.getMembers('<init>').filter((m) => m.kind === 'method').map((m) => ({ sym: m }));
    if (!ctors.length) this.error(`no constructor in ${csym.fullName}`, env, pos);
    this.forceDeferredIfOverloaded(ctors, args);
    if (diamond) {
      // treat class type parameters as method type parameters
      const tps = csym.typarams || [];
      const cands = ctors.map((c) => {
        const mt = c.sym.type;
        const ret = new T.ClassType(csym, tps.slice(), site.outer);
        return { sym: c.sym, diamondType: new T.MethodType(mt.params, ret, mt.thrown, tps.concat(mt.typarams)) };
      });
      let best = null;
      for (let phase = 1; phase <= 3 && !best; phase++) {
        const ok = cands.filter((c) => this.rs.isApplicable(c.sym, c.diamondType, args, phase)).map((c) => ({ cand: c, mtype: c.diamondType, phase }));
        if (ok.length) best = { ...this.rs.mostSpecific(ok, args, phase), phase };
      }
      if (!best) this.error(`no suitable constructor found for ${csym.fullName}`, env, pos);
      const res = { sym: best.cand.sym, mtype: best.mtype, varargs: best.phase === 3, candidate: best.cand };
      const mt = this.instantiate(res, args, pt, env, null, []);
      res.mtype = mt;
      return res;
    }
    const res = this.rs.selectMethod(site, ctors, args, typeargs, env.clazz);
    if (!res) {
      this.error(`no suitable constructor found for ${csym.fullName}(${args.map((a) => (a.type ? T.typeToString(a.type) : a.poly)).join(',')})`, env, pos);
    }
    res.mtype = this.instantiate(res, args, null, env, site, typeargs);
    return res;
  }

  attribNewClass(tree, env, pt) {
    let clazzTree = tree.clazz;
    let annotated = clazzTree;
    while (annotated.tag === 'AnnotatedType') annotated = annotated.underlying;
    clazzTree = annotated;
    const diamond = clazzTree.tag === 'TypeApply' && clazzTree.args.length === 0;
    let type;
    if (tree.encl) {
      const outerT = this.attribExpr(tree.encl, env, null);
      // inner class name is resolved as a member of the outer instance's class
      let nameTree = diamond ? clazzTree.clazz : clazzTree;
      let simple = nameTree.tag === 'Ident' ? nameTree.name : nameTree.name;
      const oc = this.rs.siteClass(outerT);
      const c = this.enter.findMemberType(oc, simple);
      if (!c) this.error(`cannot find symbol: class ${simple}`, env, tree.pos);
      let base = this.enter.memberClassType(outerT.kind === 'class' ? outerT : this.syms.erasedType(oc), c);
      if (clazzTree.tag === 'TypeApply' && !diamond) base = new T.ClassType(c, clazzTree.args.map((a) => this.resolveType(a, env)), base.outer);
      type = base;
    } else if (diamond) {
      type = this.resolveType(clazzTree.clazz, env);
    } else {
      type = this.resolveType(clazzTree, env);
    }
    const csym = type.sym;
    this.syms.completeHeader(csym);
    const args = this.attribArgs(tree.args, env);
    const typeargs = tree.typeargs.map((t) => this.resolveType(t, env));
    if (tree.body && tree.anonClass) return this.syms.erasedType(tree.anonClass);
    if (tree.body) {
      // anonymous class
      const encl = env.clazz;
      const flat = this.allocLocalName(encl, '');
      const anon = this.enter.enterLocalClass(tree.body, env, '', flat);
      anon.isAnonymous = true;
      let superType = type;
      if (diamond) {
        // infer type arguments of the anonymous superclass from the target
        superType = this.inferDiamondForAnon(type, pt, args, env, tree);
      }
      if (csym.isInterface()) {
        anon.superclass = this.objectType;
        anon.anonInterface = superType;
      } else {
        anon.superclass = superType;
      }
      // inner-ness of the anonymous class
      anon.hasOuterThis = !env.isStatic;
      this.markPrologueClass(anon, env);
      // `outer.new Inner() { ... }`: the qualifier is the superclass's enclosing
      // instance and becomes an extra constructor parameter
      if (tree.encl) anon.superOuterParam = true;
      if (env.ctorPrologue && !env.method) anon.hasOuterThis = !env.isStatic;
      this.enter.completeHeader(anon);
      const ctorSite = csym.isInterface() ? this.objectType : superType;
      const ctor = this.resolveConstructor(env, ctorSite, args, typeargs, tree.pos);
      tree.superCtor = ctor.sym;
      tree.superMtype = ctor.mtype;
      tree.varargs = ctor.varargs;
      this.finishArgs(tree.args, args, ctor.mtype, ctor.varargs, env);
      const anonCtor = this.makeAnonConstructor(anon, ctor, args, env);
      tree.sym = anonCtor;
      tree.anonClass = anon;
      tree.mtype = anonCtor.type;
      this.attribClass(anon);
      if (env.lambda) env.lambda.usesThis = env.lambda.usesThis || anon.hasOuterThis;
      tree.clazzType = superType;
      // the type of the expression is the anonymous class itself (JLS 15.9.5)
      return this.syms.erasedType(anon);
    }
    if (csym.flags & F.ABSTRACT && !csym.isInterface()) {
      // allowed only for anonymous; valid programs do not do this
    }
    const ctor = this.resolveConstructor(env, type, args, typeargs, tree.pos, pt, diamond);
    tree.sym = ctor.sym;
    tree.mtype = ctor.mtype;
    tree.varargs = ctor.varargs;
    this.finishArgs(tree.args, args, ctor.mtype, ctor.varargs, env);
    if (diamond) type = ctor.mtype.ret;
    tree.clazzType = type;
    if (csym.hasOuterThis && !tree.encl) {
      tree.implicitOuter = true;
      this.noteThisUse(env);
    }
    if (csym.isLocal && csym.hasOuterThis) this.noteThisUse(env);
    return type;
  }

  inferDiamondForAnon(type, pt, args, env, tree) {
    const csym = type.sym;
    const tps = csym.typarams || [];
    if (pt && pt.kind === 'class') {
      const sup = this.types.asSuper(pt, csym);
      // the type arguments of an anonymous class must be denotable: use the
      // non-wildcard parameterization of the target (? super X -> X)
      if (sup && sup.args.length === tps.length) return this.rs.nonWildcardParameterization(sup);
      // pt is a supertype of csym: infer csym args from pt's args
      const ctx = new InferenceContext(this.types, this.syms, tps);
      ctx.compatible(new T.ClassType(csym, ctx.ivars, type.outer), pt);
      const inst = ctx.resolve();
      return this.rs.nonWildcardParameterization(new T.ClassType(csym, inst, type.outer));
    }
    if (csym.isInterface() || !tps.length) return type;
    const res = this.resolveConstructor(env, type, args, [], tree.pos, pt, true);
    return res.mtype.ret;
  }

  // The constructor of an anonymous class takes the arguments of the super
  // constructor it delegates to.
  makeAnonConstructor(anon, superCtor, args, env) {
    this.syms.completeMembers(anon);
    // remove the generated default constructor
    anon.members.delete('<init>');
    const ptypes = superCtor.mtype.params.map((p) => this.types.erasure(p));
    let params = ptypes;
    if (superCtor.varargs) {
      // keep the varargs array parameter
    }
    const m = new MethodSymbol('<init>', F.GENERATED_CONSTRUCTOR, anon, new T.MethodType(params, PRIM.void, superCtor.sym.type.thrown, []));
    m.params = params.map((t, i) => {
      const p = new VarSymbol(`x${i}`, 0, m, t);
      p.isParam = true;
      p.isLocal = true;
      return p;
    });
    m.anonSuperCtor = superCtor.sym;
    m.anonSuperMtype = superCtor.mtype;
    m.anonVarargs = superCtor.varargs;
    if (superCtor.sym.flags & F.VARARGS) m.flags |= F.VARARGS;
    anon.addMember(m);
    anon.anonCtor = m;
    return m;
  }

  attribNewArray(tree, env, pt) {
    if (!tree.elemtype) {
      // initializer without type: annotation value or array initializer in a declaration
      if (!pt) this.error('array initializer needs a target type', env, tree.pos);
      return this.attribArrayInit(tree, env, pt);
    }
    const et = this.resolveType(tree.elemtype, env);
    for (const d of tree.dims) this.attribExprCoerce(d, env, PRIM.int);
    let type = et;
    const n = tree.dims.length || 1;
    for (let i = 0; i < n; i++) type = new T.ArrayType(type);
    if (tree.elems) {
      const elem = this.types.elemtype(type);
      for (const e of tree.elems) {
        if (e.tag === 'NewArray' && !e.elemtype) this.attribArrayInit(e, env, elem);
        else this.attribExprCoerce(e, env, elem);
      }
    }
    return type;
  }

  attribArrayInit(tree, env, type) {
    const elem = this.types.elemtype(type);
    if (!elem) this.error(`illegal initializer for ${T.typeToString(type)}`, env, tree.pos);
    for (const e of tree.elems) {
      if (e.tag === 'NewArray' && !e.elemtype) this.attribArrayInit(e, env, elem);
      else this.attribExprCoerce(e, env, elem);
    }
    tree.type = type;
    return type;
  }

  // ---- operators -----------------------------------------------------------------
  attribAssignOp(tree, env) {
    const lt = this.attribExpr(tree.lhs, env, null);
    const rt = this.attribExpr(tree.rhs, env, null);
    if (tree.op === '+' && this.isString(lt)) {
      tree.stringConcat = true;
      return lt;
    }
    const lp = this.types.unboxedTypeOrSelf(lt);
    const rp = this.types.unboxedTypeOrSelf(rt);
    let opType;
    if (tree.op === '<<' || tree.op === '>>' || tree.op === '>>>') {
      opType = this.types.unaryPromotion(lp);
      tree.rhs.coerceTo = this.types.unaryPromotion(rp);
      if (tree.rhs.coerceTo && tree.rhs.coerceTo.tag === 'long') tree.rhs.coerceTo = PRIM.long;
    } else if (lp && lp.tag === 'boolean') {
      opType = PRIM.boolean;
      tree.rhs.coerceTo = PRIM.boolean;
    } else {
      opType = this.types.binaryPromotion(lp, rp);
      tree.rhs.coerceTo = opType;
    }
    tree.opType = opType;
    return lt;
  }

  attribUnary(tree, env) {
    const op = tree.op;
    const t = this.attribExpr(tree.arg, env, null);
    if (/^(pre|post)/.test(op)) {
      tree.opType = this.types.unboxedTypeOrSelf(t);
      return t;
    }
    if (op === 'not') {
      tree.arg.coerceTo = PRIM.boolean;
      if (tree.arg.constValue !== undefined) tree.constValue = !tree.arg.constValue;
      return PRIM.boolean;
    }
    const pt = this.types.unaryPromotion(t);
    if (!pt) this.error(`bad operand type ${T.typeToString(t)} for unary operator`, env, tree.pos);
    tree.arg.coerceTo = pt;
    if (tree.arg.constValue !== undefined) {
      const v = CF.convert(tree.arg.constValue, this.primTag(tree.arg.type), pt.tag);
      const r = CF.unary(op, v, pt.tag);
      if (r !== undefined) tree.constValue = r;
    }
    return pt;
  }

  primTag(t) {
    if (t.kind === 'prim') return t.tag;
    if (this.isString(t)) return 'String';
    const u = this.types.unboxedType(t);
    return u ? u.tag : null;
  }

  attribBinary(tree, env) {
    const op = tree.op;
    // flatten long string concatenation chains iteratively to avoid deep recursion
    const lt = this.attribExpr(tree.lhs, env, null);
    if (op === '&&' || op === '||') {
      tree.lhs.coerceTo = PRIM.boolean;
      const rt = this.attribExpr(tree.rhs, env, null);
      tree.rhs.coerceTo = PRIM.boolean;
      tree.opType = PRIM.boolean;
      const a = tree.lhs.constValue;
      const b = tree.rhs.constValue;
      if (a !== undefined && b !== undefined) tree.constValue = op === '&&' ? (a && b) : (a || b);
      return PRIM.boolean;
    }
    const rt = this.attribExpr(tree.rhs, env, null);
    if (op === '+' && (this.isString(lt) || this.isString(rt))) {
      tree.stringConcat = true;
      const a = tree.lhs.constValue;
      const b = tree.rhs.constValue;
      if (a !== undefined && b !== undefined && a !== null && b !== null) {
        tree.constValue = CF.constToString(a, this.primTag(lt)) + CF.constToString(b, this.primTag(rt));
      }
      return this.stringType;
    }
    const lp = this.types.unboxedTypeOrSelf(lt);
    const rp = this.types.unboxedTypeOrSelf(rt);
    let opType;
    let result;
    switch (op) {
      case '*': case '/': case '%': case '+': case '-':
        opType = this.types.binaryPromotion(lp, rp);
        result = opType;
        break;
      case '<<': case '>>': case '>>>': {
        opType = this.types.unaryPromotion(lp);
        const ro = this.types.unaryPromotion(rp);
        tree.lhs.coerceTo = opType;
        tree.rhs.coerceTo = ro;
        tree.opType = opType;
        if (tree.lhs.constValue !== undefined && tree.rhs.constValue !== undefined) {
          const a = CF.convert(tree.lhs.constValue, this.primTag(lt), opType.tag);
          const b = CF.convert(tree.rhs.constValue, this.primTag(rt), ro.tag);
          const r = opType.tag === 'long' ? CF.shiftLong(op, a, b) : CF.binary(op, a, typeof b === 'bigint' ? Number(b & 63n) : b, 'int');
          if (r !== undefined) tree.constValue = r;
        }
        return opType;
      }
      case '<': case '>': case '<=': case '>=':
        opType = this.types.binaryPromotion(lp, rp);
        result = PRIM.boolean;
        break;
      case '==': case '!=':
        if (lp && rp && (lt.kind === 'prim' || rt.kind === 'prim')) {
          // numeric or boolean equality (with unboxing)
          if (lp.tag === 'boolean' && rp.tag === 'boolean') opType = PRIM.boolean;
          else opType = this.types.binaryPromotion(lp, rp);
        } else {
          opType = null; // reference equality
        }
        result = PRIM.boolean;
        break;
      case '&': case '|': case '^':
        if (lp && rp && lp.tag === 'boolean' && rp.tag === 'boolean') opType = PRIM.boolean;
        else opType = this.types.binaryPromotion(lp, rp);
        result = opType;
        break;
      default:
        this.error(`bad operator ${op}`, env, tree.pos);
    }
    tree.opType = opType;
    if (opType) {
      tree.lhs.coerceTo = opType;
      tree.rhs.coerceTo = opType;
    }
    if (opType && tree.lhs.constValue !== undefined && tree.rhs.constValue !== undefined) {
      const a = CF.convert(tree.lhs.constValue, this.primTag(lt), opType.tag);
      const b = CF.convert(tree.rhs.constValue, this.primTag(rt), opType.tag);
      const r = CF.binary(op, a, b, opType.tag);
      if (r !== undefined) tree.constValue = r;
    }
    if (!result) this.error(`bad operand types for ${op}: ${T.typeToString(lt)}, ${T.typeToString(rt)}`, env, tree.pos);
    return result;
  }

  attribConditional(tree, env, pt) {
    this.attribCond(tree.cond, env);
    const isPoly = pt && pt.kind !== 'prim' && (this.isPolyBranch(tree.truepart) || this.isPolyBranch(tree.falsepart));
    if (isPoly) {
      this.attribExprCoerce(tree.truepart, env, pt);
      this.attribExprCoerce(tree.falsepart, env, pt);
      return pt;
    }
    const tt = this.attribExpr(tree.truepart, env, pt && pt.kind !== 'prim' ? pt : pt);
    const ft = this.attribExpr(tree.falsepart, env, pt && pt.kind !== 'prim' ? pt : pt);
    const type = this.conditionalType(tree, tt, ft, pt);
    tree.truepart.coerceTo = type;
    tree.falsepart.coerceTo = type;
    const c = tree.cond.constValue;
    if (c !== undefined && tree.truepart.constValue !== undefined && tree.falsepart.constValue !== undefined) {
      const v = c ? tree.truepart.constValue : tree.falsepart.constValue;
      const from = c ? tt : ft;
      const cv = this.coerceConst(v, from, type);
      if (cv !== undefined) tree.constValue = cv;
    }
    return type;
  }

  // JLS 15.25
  conditionalType(tree, tt, ft, pt) {
    const tu = this.types.unboxedTypeOrSelf(tt);
    const fu = this.types.unboxedTypeOrSelf(ft);
    if (tt.kind === 'prim' && ft.kind === 'prim' && tt.tag === ft.tag) return tt;
    if (tu && fu && tu.tag === 'boolean' && fu.tag === 'boolean' && (tt.kind === 'prim' || ft.kind === 'prim')) return PRIM.boolean;
    if (tu && fu && tu.tag !== 'boolean' && fu.tag !== 'boolean' && (tt.kind === 'prim' || ft.kind === 'prim' || true) && T.isNumericTag(tu.tag) && T.isNumericTag(fu.tag)) {
      // numeric conditional (only when both operands are convertible to numeric types)
      if (tt.kind === 'prim' || ft.kind === 'prim' || (this.types.unboxedType(tt) && this.types.unboxedType(ft))) {
        if (tu.tag === fu.tag) return tu;
        const narrow = (a, aTree, b) => {
          // a is byte/short/char and b is an int constant representable in a
          if ((a.tag === 'byte' || a.tag === 'short' || a.tag === 'char') && b.tree.constValue !== undefined && b.type.kind === 'prim' && b.type.tag === 'int') {
            const v = b.tree.constValue;
            if (a.tag === 'byte' && v >= -128 && v <= 127) return a;
            if (a.tag === 'short' && v >= -32768 && v <= 32767) return a;
            if (a.tag === 'char' && v >= 0 && v <= 65535) return a;
          }
          return null;
        };
        if ((tu.tag === 'byte' && fu.tag === 'short') || (tu.tag === 'short' && fu.tag === 'byte')) return PRIM.short;
        const n1 = narrow(tu, tree.truepart, { tree: tree.falsepart, type: ft });
        if (n1) return n1;
        const n2 = narrow(fu, tree.falsepart, { tree: tree.truepart, type: tt });
        if (n2) return n2;
        return this.types.binaryPromotion(tu, fu);
      }
    }
    // reference conditional
    if (tt.kind === 'null' && ft.kind === 'null') return T.NULL;
    const bt = tt.kind === 'prim' ? this.types.boxedClass(tt) : tt;
    const bf = ft.kind === 'prim' ? this.types.boxedClass(ft) : ft;
    if (pt && pt.kind !== 'prim' && (this.isGenericPoly(tree.truepart) || this.isGenericPoly(tree.falsepart))) return pt;
    if (bt.kind === 'null') return bf;
    if (bf.kind === 'null') return bt;
    return this.types.lub([bt, bf]);
  }

  isGenericPoly(t) {
    const u = unparen(t);
    return u.tag === 'Apply' || (u.tag === 'NewClass' && u.clazz.tag === 'TypeApply' && u.clazz.args.length === 0);
  }

  attribCast(tree, env) {
    const ct = this.resolveType(tree.clazz, env);
    const u = unparen(tree.expr);
    if (u.tag === 'Lambda' || u.tag === 'Reference') {
      this.attribExpr(tree.expr, env, ct);
      tree.expr.coerceTo = ct;
      return ct;
    }
    const et = this.attribExpr(tree.expr, env, ct.kind === 'prim' ? null : null);
    if (tree.expr.constValue !== undefined && (ct.kind === 'prim' || this.isString(ct))) {
      const from = this.primTag(et);
      const to = ct.kind === 'prim' ? ct.tag : 'String';
      if (from && (to !== 'String' || from === 'String')) tree.constValue = CF.convert(tree.expr.constValue, from, to);
    }
    return ct;
  }

  attribInstanceOf(tree, env) {
    const et = this.attribExpr(tree.expr, env, null);
    if (tree.pattern) {
      this.attribPattern(tree.pattern, env, et);
      tree.patternType = tree.pattern.type;
    } else {
      tree.clazzType = this.resolveType(tree.clazz, env);
    }
    return PRIM.boolean;
  }

  // Bindings are entered into the innermost enclosing block scope (valid
  // programs do not reuse a binding name while it is in scope).
  bindingScope(env) {
    let e = env;
    while (e && e.kind !== 'block' && e.kind !== 'method' && e.kind !== 'lambda') e = e.outer;
    return e || env;
  }

  attribPattern(p, env, targetType) {
    switch (p.tag) {
      case 'BindingPattern': {
        const v = p.var;
        let vt;
        if (v.vartype) vt = this.resolveType(v.vartype, env);
        else vt = this.types.upward(targetType);
        const scope = this.bindingScope(env);
        const sym = this.newLocal(v, vt, scope);
        sym.lambda = env.lambda;
        v.sym = sym;
        p.type = vt;
        return vt;
      }
      case 'RecordPattern': {
        let rt = this.resolveType(p.deconstructor, env);
        const rsym = rt.sym;
        this.syms.completeMembers(rsym);
        if (rsym.typarams && rsym.typarams.length && rt.args.length === 0) {
          // infer record type arguments from the target
          const sup = targetType && targetType.kind === 'class' ? this.types.asSuper(targetType, rsym) : null;
          if (sup) rt = sup;
        }
        p.type = rt;
        p.recordSym = rsym;
        const comps = rsym.recordComponents || [];
        p.accessors = [];
        p.nested.forEach((n, i) => {
          const comp = comps[i];
          const ct = comp ? this.types.memberType(rt, comp) : this.objectType;
          const acc = this.rs.collectMethods(rsym, comp.name).find((m) => m.params.length === 0);
          p.accessors.push({ comp, acc, type: ct });
          if (n.tag === 'AnyPattern') { n.type = ct; return; }
          this.attribPattern(n, env, ct);
        });
        return rt;
      }
      case 'AnyPattern':
        p.type = targetType;
        return targetType;
      default:
        this.error(`unexpected pattern ${p.tag}`, env, p.pos);
    }
    return null;
  }

  // ---- lambdas and method references ---------------------------------------------
  attribLambda(tree, env, pt) {
    if (tree.done) return tree.type;
    if (!pt) this.error('lambda expression not expected here', env, tree.pos);
    const fn = this.rs.functionType(pt);
    if (!fn) this.error(`${T.typeToString(pt)} is not a functional interface`, env, tree.pos);
    this.attribLambdaWith(tree, env, pt, fn, false);
    tree.done = true;
    return pt;
  }

  attribLambdaWith(tree, env, target, fn, collect) {
    const lenv = env.dup('lambda');
    const info = {
      tree,
      captured: [],
      usesThis: false,
      returnType: fn ? fn.type.ret : null,
      returnTypes: [],
      collectReturns: true,
      outerEnv: env,
    };
    lenv.lambda = info;
    lenv.yieldTarget = null;
    lenv.returnType = fn ? fn.type.ret : null;
    tree.lambdaInfo = info;
    tree.target = target;
    tree.fn = fn;
    const ptypes = fn ? fn.type.params : [];
    tree.params.forEach((p, i) => {
      let t;
      if (p.vartype) t = this.resolveType(p.vartype, lenv);
      else t = ptypes[i] ? this.lambdaParamType(ptypes[i]) : this.objectType;
      const sym = new VarSymbol(p.name, (p.mods && p.mods.flags & F.FINAL) || 0, env.method || (env.info && env.info.csym), t);
      sym.isLocal = true;
      sym.isParam = true;
      sym.lambda = info;
      sym.tree = p;
      p.sym = sym;
      lenv.addLocal(sym);
    });
    const rt = fn ? fn.type.ret : null;
    if (tree.body.tag === 'Block') {
      const benv = lenv.dup('block');
      this.attribBlockStats(tree.body.stats, benv);
    } else {
      const isVoid = rt && rt.kind === 'prim' && rt.tag === 'void';
      const et = this.attribExpr(tree.body, lenv, isVoid ? null : this.properTarget(rt));
      if (!isVoid) {
        info.returnTypes.push(et);
        tree.body.coerceTo = rt;
      }
    }
    tree.returnTypes = info.returnTypes;
    tree.type = target;
  }

  properTarget(rt) {
    if (!rt) return null;
    if (rt.kind === 'tvar' && rt.isInferenceVar) return null;
    if (this.containsInferenceVar(rt)) return null;
    return rt;
  }

  containsInferenceVar(t) {
    if (!t) return false;
    switch (t.kind) {
      case 'tvar': return !!t.isInferenceVar;
      case 'class': return t.args.some((a) => this.containsInferenceVar(a)) || (t.outer ? this.containsInferenceVar(t.outer) : false);
      case 'array': return this.containsInferenceVar(t.elem);
      case 'wildcard': return t.bound ? this.containsInferenceVar(t.bound) : false;
      case 'intersection': return t.bounds.some((b) => this.containsInferenceVar(b));
      default: return false;
    }
  }

  lambdaParamType(t) {
    if (t.kind === 'wildcard') return this.upperOf(t);
    if (t.kind === 'tvar' && t.isInferenceVar) return (t.bounds && t.bounds[0]) || this.objectType;
    return t;
  }

  attribReference(tree, env, pt) {
    if (tree.done) return tree.type;
    if (!pt) this.error('method reference not expected here', env, tree.pos);
    const fn = this.rs.functionType(pt);
    if (!fn) this.error(`${T.typeToString(pt)} is not a functional interface`, env, tree.pos);
    tree.target = pt;
    tree.fn = fn;
    const ptypes = fn.type.params.map((p) => this.lambdaParamType(p));
    const expr = tree.expr;
    // qualifier: type or expression
    let qualType;
    let qualIsType = false;
    if (expr.tag === 'Ident' && expr.name === 'super') {
      qualType = this.syms.completeHeader(env.clazz).superclass;
      tree.refKind = 'super';
      this.noteThisUse(env);
    } else if (expr.tag === 'Select' && expr.name === 'super') {
      const q = this.resolveType(expr.selected, env);
      qualType = q.sym.isInterface() ? q : this.syms.completeHeader(q.sym).superclass;
      tree.refKind = 'super';
      tree.superIface = q.sym.isInterface() ? q.sym : null;
      this.noteThisUse(env);
    } else if (expr.tag === 'ArrayType' || expr.tag === 'PrimitiveType' || expr.tag === 'TypeApply' || expr.tag === 'AnnotatedType') {
      qualType = this.resolveType(expr, env);
      qualIsType = true;
    } else {
      qualType = this.attribQualifier(expr, env);
      qualIsType = !!expr.isType;
    }
    tree.qualType = qualType;
    tree.qualIsType = qualIsType;
    if (tree.mode === 'new') {
      if (qualType.kind === 'array') {
        tree.refKind = 'arrayCtor';
        tree.refReturnType = qualType;
        tree.done = true;
        return pt;
      }
      let ctype = qualType;
      const csym = ctype.sym;
      this.syms.completeHeader(csym);
      const args = ptypes.map((t) => ({ type: t, poly: null }));
      const diamond = csym.typarams && csym.typarams.length && ctype.args.length === 0;
      const res = this.resolveConstructor(env, ctype, args, [], tree.pos, fn.type.ret.kind !== 'prim' ? fn.type.ret : null, !!diamond);
      tree.sym = res.sym;
      tree.mtype = res.mtype;
      tree.refKind = 'ctor';
      tree.varargs = res.varargs;
      tree.refReturnType = diamond ? res.mtype.ret : ctype;
      tree.done = true;
      if (csym.hasOuterThis) this.noteThisUse(env);
      return pt;
    }
    const name = tree.name;
    const typeargs = tree.typeargs.map((t) => this.resolveType(t, env));
    if (qualIsType) {
      // static method with all params, or instance method with first param as receiver
      const site = qualType;
      const cands = this.rs.methodsInSite(site, name);
      const args1 = ptypes.map((t) => ({ type: t, poly: null }));
      const r1 = this.rs.selectMethod(site, cands.filter((c) => c.sym.flags & F.STATIC), args1, typeargs, env.clazz);
      let r2 = null;
      if (ptypes.length >= 1) {
        let recvSite = site;
        if (site.kind === 'class' && site.args.length === 0 && site.sym.typarams && site.sym.typarams.length) {
          // raw qualifier: use the receiver parameter's parameterization (JLS 15.13.1)
          const sup = this.types.asSuper(ptypes[0], site.sym);
          if (sup) recvSite = sup;
        }
        const args2 = ptypes.slice(1).map((t) => ({ type: t, poly: null }));
        const cands2 = this.rs.methodsInSite(recvSite, name).filter((c) => !(c.sym.flags & F.STATIC));
        r2 = this.rs.selectMethod(recvSite, cands2, args2, typeargs, env.clazz);
        if (r2) r2.site = recvSite;
      }
      let res;
      if (r1 && r2) {
        // prefer the more specific / non-ambiguous one: valid code has one applicable form
        res = r1.sym.params.length === ptypes.length ? r1 : r2;
        tree.refKind = res === r1 ? 'static' : 'unbound';
      } else if (r1) { res = r1; tree.refKind = 'static'; }
      else if (r2) { res = r2; tree.refKind = 'unbound'; }
      else this.error(`invalid method reference ${T.typeToString(site)}::${name}`, env, tree.pos);
      const args = tree.refKind === 'static' ? args1 : ptypes.slice(1).map((t) => ({ type: t, poly: null }));
      res.mtype = this.instantiate(res, args, fn.type.ret.kind !== 'prim' ? fn.type.ret : null, env, res.site || site, typeargs);
      tree.sym = res.sym;
      tree.mtype = res.mtype;
      tree.varargs = res.varargs;
      tree.refReturnType = res.mtype.ret;
      if (res.candidate && res.candidate.arrayClone) tree.arrayClone = true;
      tree.done = true;
      return pt;
    }
    // bound receiver (expression or super)
    const site = qualType;
    const cands = this.rs.methodsInSite(site, name);
    const args = ptypes.map((t) => ({ type: t, poly: null }));
    const res = this.rs.selectMethod(site, cands, args, typeargs, env.clazz);
    if (!res) this.error(`invalid method reference ${name}`, env, tree.pos);
    res.mtype = this.instantiate(res, args, fn.type.ret.kind !== 'prim' ? fn.type.ret : null, env, site, typeargs);
    tree.sym = res.sym;
    tree.mtype = res.mtype;
    tree.varargs = res.varargs;
    if (!tree.refKind) tree.refKind = (res.sym.flags & F.STATIC) ? 'static' : 'bound';
    tree.refReturnType = res.mtype.ret;
    if (res.candidate && res.candidate.arrayClone) tree.arrayClone = true;
    tree.done = true;
    return pt;
  }

  // ---- switch -------------------------------------------------------------------
  attribSwitch(tree, env, isExpr, pt) {
    const st = this.attribExpr(tree.selector, env, null);
    const unboxed = this.types.unboxedTypeOrSelf(st);
    let kind;
    const enumSym = st.kind === 'class' && this.syms.completeHeader(st.sym).isEnum() ? st.sym : null;
    const hasPatterns = tree.cases.some((c) => c.labels.some((l) => l.tag === 'PatternCaseLabel' || (l.tag === 'ConstantCaseLabel' && l.expr.tag === 'Literal' && l.expr.typetag === 'null') || l.tag === 'NullDefaultCaseLabel'));
    if (hasPatterns) kind = 'pattern';
    else if (enumSym) kind = 'enum';
    else if (this.isString(st)) kind = 'string';
    else if (unboxed && ['int', 'short', 'char', 'byte'].includes(unboxed.tag)) kind = 'int';
    else if (unboxed && ['long', 'float', 'double', 'boolean'].includes(unboxed.tag)) kind = 'primitive';
    else kind = 'pattern';
    tree.switchKind = kind;
    tree.enumSym = enumSym;
    if (kind === 'int') tree.selector.coerceTo = PRIM.int;
    const yieldTarget = isExpr ? { pt: pt && pt.kind !== 'prim' ? pt : pt, types: [], values: [] } : null;
    const swenv = env.dup('block');
    swenv.yieldTarget = yieldTarget;
    if (isExpr) swenv.inSwitchExpr = true;
    // the statements of all `case ...:` groups form a single block (JLS 14.11.1);
    // each `case ... ->` rule has its own scope
    const sharedEnv = swenv.dup('block');
    for (const c of tree.cases) {
      const cenv = c.arrow ? swenv.dup('block') : sharedEnv;
      for (const l of c.labels) {
        if (l.tag === 'ConstantCaseLabel') {
          const e = l.expr;
          if (kind === 'enum' && unparen(e).tag === 'Ident') {
            const id = unparen(e);
            const f = this.rs.findField(enumSym, id.name);
            if (!f) this.error(`unknown enum constant ${id.name}`, env, e.pos);
            id.sym = f;
            id.type = this.syms.erasedType(enumSym);
            e.type = id.type;
            l.enumConst = f;
          } else if (kind === 'pattern' && e.tag === 'Literal' && e.typetag === 'null') {
            e.type = T.NULL;
            l.isNull = true;
          } else {
            const t = this.attribExpr(e, cenv, unboxed && unboxed.kind === 'prim' ? unboxed : st);
            if (kind === 'pattern' || kind === 'enum') {
              // qualified enum constant in a pattern switch, or constants of boxed types
              if (e.sym && e.sym.kind === 'var' && (e.sym.flags & F.ENUM)) l.enumConst = e.sym;
            }
            if (e.constValue === undefined && !l.enumConst) this.error('constant expression required', env, e.pos);
            if (e.constValue !== undefined && kind !== 'string') {
              const target = unboxed && unboxed.kind === 'prim' ? unboxed : this.types.unboxedTypeOrSelf(t);
              l.value = this.coerceConst(e.constValue, t, target && target.kind === 'prim' && target.tag !== 'boolean' && ['long', 'float', 'double'].includes(target.tag) ? target : (kind === 'int' ? PRIM.int : (target || t)));
            } else l.value = e.constValue;
          }
        } else if (l.tag === 'PatternCaseLabel') {
          this.attribPattern(l.pat, cenv, st);
        }
      }
      if (c.guard) this.attribCond(c.guard, cenv);
      if (c.arrow && c.body && c.body.tag === 'Exec' && isExpr) {
        // expression arm: its value is yielded
        const t = this.attribExpr(c.body.expr, cenv, yieldTarget.pt);
        yieldTarget.types.push(t);
        yieldTarget.values.push(c.body.expr);
        c.body.isYieldValue = true;
      } else {
        for (const s of c.stats) this.attribStat(s, cenv);
      }
    }
    tree.hasDefault = tree.cases.some((c) => c.labels.some((l) => l.tag === 'DefaultCaseLabel' || l.tag === 'NullDefaultCaseLabel')) ||
      tree.cases.some((c) => c.labels.some((l) => l.tag === 'PatternCaseLabel' && !c.guard && this.isUnconditionalPattern(l.pat, st)));
    if (!isExpr) return null;
    // switch expression type
    let type;
    const ts = yieldTarget.types;
    if (pt && pt.kind !== 'prim' && yieldTarget.values.some((v) => this.isPolyBranch(v) || this.isGenericPoly(v))) type = pt;
    else type = this.switchResultType(ts, yieldTarget.values, pt);
    for (const v of yieldTarget.values) v.coerceTo = type;
    tree.resultType = type;
    return type;
  }

  isUnconditionalPattern(p, st) {
    if (p.tag !== 'BindingPattern') return false;
    const pt = p.type;
    return this.types.isSubtype(this.types.erasure(st), this.types.erasure(pt));
  }

  switchResultType(ts, values, pt) {
    if (!ts.length) return pt || this.objectType;
    if (ts.every((t) => t.kind === 'prim' && t.tag === ts[0].tag)) return ts[0];
    const unb = ts.map((t) => this.types.unboxedTypeOrSelf(t));
    if (unb.every((u) => u && u.tag === 'boolean')) return PRIM.boolean;
    if (unb.every((u) => u && T.isNumericTag(u.tag))) {
      // numeric promotion across all arms (simplified 15.28.1)
      let r = unb[0];
      for (let i = 1; i < unb.length; i++) {
        if (r.tag === unb[i].tag) continue;
        r = this.types.binaryPromotion(r, unb[i]);
      }
      // keep narrow types when all are the same narrow type or constants fit
      return r;
    }
    if (pt && pt.kind !== 'prim') return pt;
    return this.types.lub(ts.map((t) => (t.kind === 'prim' ? this.types.boxedClass(t) : t)));
  }
}

module.exports = { Attr, unparen };
