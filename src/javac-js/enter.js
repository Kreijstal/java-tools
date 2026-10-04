'use strict';

// Enter: create class symbols for compilation units, complete class headers
// (type parameters, supertypes) and members (fields, methods, implicit
// members of enums and records) on demand. Also hosts environments and type
// name resolution shared with attribution.

const { F } = require('./flags');
const T = require('./types');
const { ClassSymbol, MethodSymbol, VarSymbol } = require('./symbols');

class CompileError extends Error {
  constructor(message, file, pos, lineCol) {
    let loc = '';
    if (file) {
      if (lineCol && pos !== undefined && pos !== null) {
        const lc = lineCol(pos);
        loc = `${file}:${lc.line}:${lc.col}: `;
      } else loc = `${file}: `;
    }
    super(loc + message);
    this.file = file;
    this.pos = pos;
  }
}

// ---------------------------------------------------------------------------
// Environments

class Env {
  constructor(kind, outer) {
    this.kind = kind; // 'unit' | 'class' | 'method' | 'block' | 'lambda'
    this.outer = outer || null;
    this.unit = outer ? outer.unit : null; // CompilationUnit info
    this.clazz = outer ? outer.clazz : null; // enclosing ClassSymbol
    this.method = outer ? outer.method : null; // enclosing MethodSymbol (null in field init/initializer)
    this.isStatic = outer ? outer.isStatic : false; // static context
    this.scope = null; // Map name -> VarSymbol (locals)
    this.localClasses = null; // Map name -> ClassSymbol
    this.typeVars = null; // Map name -> TypeVar
    this.lambda = outer ? outer.lambda : null;
    this.ctorPrologue = outer ? outer.ctorPrologue : false;
    this.returnType = outer ? outer.returnType : null;
    this.yieldTarget = null;
    this.info = outer ? outer.info : null; // per-method attribution state
  }

  dup(kind) {
    return new Env(kind || this.kind, this);
  }

  addLocal(sym) {
    if (!this.scope) this.scope = new Map();
    this.scope.set(sym.name, sym);
  }

  addLocalClass(sym) {
    if (!this.localClasses) this.localClasses = new Map();
    this.localClasses.set(sym.name, sym);
  }

  addTypeVar(tv) {
    if (!this.typeVars) this.typeVars = new Map();
    this.typeVars.set(tv.name, tv);
  }
}

// Per compilation unit import information.
class UnitInfo {
  constructor(cu, pkg) {
    this.cu = cu;
    this.pkg = pkg; // PackageSymbol
    this.file = cu.file;
    this.lineCol = cu.lineCol || null;
    this.singleImports = new Map(); // simple name -> qualified name text
    this.onDemand = []; // qualified name text (package or class)
    this.staticSingle = []; // {owner: text, name}
    this.staticOnDemand = []; // owner text
    this.resolvedSingle = new Map();
    this.topLevel = new Map(); // simple name -> ClassSymbol declared in this unit
  }
}

function qualifiedName(tree) {
  if (!tree) return '';
  if (tree.tag === 'Ident') return tree.name;
  if (tree.tag === 'Select') return `${qualifiedName(tree.selected)}.${tree.name}`;
  throw new Error(`not a qualified name: ${tree.tag}`);
}

// ---------------------------------------------------------------------------

class Enter {
  constructor(compiler) {
    this.c = compiler;
    this.syms = compiler.syms;
    this.types = compiler.syms.types;
    this.syms.enterUnit = (cu) => this.enterUnit(cu);
    this.syms.completeHeaderHook = (sym) => this.completeHeader(sym);
    this.syms.completeMembersHook = (sym) => this.completeMembers(sym);
    this.units = [];
  }

  error(msg, unit, pos) {
    throw new CompileError(msg, unit ? unit.file : null, pos, unit ? unit.lineCol : null);
  }

  // ---- entering compilation units ------------------------------------------
  enterUnit(cu) {
    const pkgName = cu.pkg ? qualifiedName(cu.pkg) : '';
    const pkg = this.syms.enterPackage(pkgName);
    pkg.exists = true;
    const info = new UnitInfo(cu, pkg);
    cu.info = info;
    for (const imp of cu.imports) {
      if (imp.isModule) continue;
      const q = qualifiedName(imp.qualid);
      if (imp.isStatic) {
        if (imp.wildcard) info.staticOnDemand.push(q);
        else {
          const k = q.lastIndexOf('.');
          info.staticSingle.push({ owner: q.slice(0, k), name: q.slice(k + 1) });
        }
      } else if (imp.wildcard) info.onDemand.push(q);
      else info.singleImports.set(q.slice(q.lastIndexOf('.') + 1), q);
    }
    const unitEnv = new Env('unit', null);
    unitEnv.unit = info;
    info.env = unitEnv;
    for (const decl of cu.types) {
      const sym = this.enterClass(decl, pkg, info, unitEnv, null);
      info.topLevel.set(sym.name, sym);
    }
    this.units.push(cu);
  }

  classFlags(decl, owner) {
    let flags = decl.mods.flags & 0xffff | (decl.mods.flags & (F.SEALED | F.NON_SEALED | F.DEPRECATED));
    switch (decl.kind) {
      case 'interface': flags |= F.INTERFACE | F.ABSTRACT; break;
      case 'annotation': flags |= F.INTERFACE | F.ABSTRACT | F.ANNOTATION; break;
      case 'enum': {
        flags |= F.ENUM;
        // an enum is implicitly final unless a constant has a class body
        const hasBodies = decl.defs.some((d) => d.tag === 'VarDecl' && d.enumConstant && d.enumConstant.body);
        if (!hasBodies) flags |= F.FINAL;
        else flags |= F.SEALED;
        // abstract if it declares abstract methods (constants then supply bodies)
        if (decl.defs.some((d) => d.tag === 'MethodDecl' && (d.mods.flags & F.ABSTRACT))) flags |= F.ABSTRACT;
        break;
      }
      case 'record': flags |= F.RECORD | F.FINAL; break;
      default: break;
    }
    if (owner && owner.kind === 'class') {
      // member types of interfaces are implicitly public static
      if (owner.isInterface()) flags |= F.PUBLIC | F.STATIC;
      if (decl.kind !== 'class') flags |= F.STATIC; // nested enums, records, interfaces
    }
    if (decl.mods.annotations.some((a) => qualifiedName(a.annotationType).endsWith('Deprecated'))) flags |= F.DEPRECATED;
    return flags;
  }

  enterClass(decl, owner, unit, outerEnv, outerClass) {
    const flags = this.classFlags(decl, outerClass);
    const sym = new ClassSymbol(decl.name, flags, outerClass || owner);
    sym.classKind = decl.kind;
    sym.tree = decl;
    sym.unit = unit;
    decl.sym = sym;
    if (outerClass) {
      sym.fullName = `${outerClass.fullName}.${decl.name}`;
      sym.flatName = `${outerClass.flatName}$${decl.name}`;
      outerClass.memberClasses.set(decl.name, sym);
      outerClass.addMember(sym);
      sym.hasOuterThis = !(flags & F.STATIC) && !outerClass.isInterface();
    } else {
      sym.fullName = owner.fullName ? `${owner.fullName}.${decl.name}` : decl.name;
      sym.flatName = sym.fullName;
      if (owner.classes.has(decl.name) && owner.classes.get(decl.name) !== sym) {
        // duplicate definition (e.g. same file loaded twice): keep the first
        const prev = owner.classes.get(decl.name);
        decl.sym = prev;
        return prev;
      }
      owner.classes.set(decl.name, sym);
    }
    this.syms.classes.set(sym.flatName, sym);
    sym.outerEnv = outerEnv;
    for (const d of decl.defs) {
      if (d.tag === 'ClassDecl') this.enterClass(d, owner, unit, null, sym);
    }
    return sym;
  }

  // Create a symbol for a local or anonymous class (called from Attr).
  enterLocalClass(decl, env, name, flatName) {
    const flags = this.classFlags(decl, null);
    const sym = new ClassSymbol(name, flags, env.method || env.clazz);
    sym.classKind = decl.kind;
    sym.tree = decl;
    sym.unit = env.unit;
    decl.sym = sym;
    sym.fullName = name;
    sym.flatName = flatName;
    sym.isLocal = true;
    sym.isAnonymous = !!decl.anonymous || !!decl.isEnumConstantBody;
    sym.localEnv = env;
    sym.hasOuterThis = !env.isStatic && decl.kind === 'class';
    if (decl.kind !== 'class') sym.flags |= F.STATIC;
    this.syms.classes.set(flatName, sym);
    for (const d of decl.defs) {
      if (d.tag === 'ClassDecl') this.enterClass(d, null, env.unit, null, sym);
    }
    return sym;
  }

  // ---- class environments --------------------------------------------------
  classEnv(sym) {
    if (sym.env) return sym.env;
    let outer;
    if (sym.isLocal) outer = sym.localEnv;
    else if (sym.owner.kind === 'class') outer = this.classEnv(sym.owner);
    else outer = sym.unit.env;
    const env = new Env('class', outer);
    env.clazz = sym;
    env.method = null;
    env.isStatic = false;
    env.lambda = null;
    env.ctorPrologue = false;
    env.unit = sym.unit;
    sym.env = env;
    return env;
  }

  // ---- header completion ---------------------------------------------------
  completeHeader(sym) {
    if (sym.headerState !== 0) return;
    sym.headerState = 1;
    const decl = sym.tree;
    const env = this.classEnv(sym);
    sym.typarams = [];
    if (decl) {
      for (const tp of decl.typarams || []) {
        const tv = new T.TypeVar(tp.name, sym);
        sym.typarams.push(tv);
        env.addTypeVar(tv);
      }
      for (let i = 0; i < (decl.typarams || []).length; i++) {
        const tp = decl.typarams[i];
        sym.typarams[i].bounds = tp.bounds.length ? tp.bounds.map((b) => this.resolveType(b, env)) : [this.syms.objectType];
      }
    }
    const isObject = sym.fullName === 'java.lang.Object';
    if (decl && decl.extending) {
      sym.superclass = this.resolveType(decl.extending, env);
    } else if (decl && decl.anonymous) {
      // set by Attr before completion
      sym.superclass = sym.superclass || this.syms.objectType;
    } else if (isObject) {
      sym.superclass = null;
    } else if (decl && decl.isEnumConstantBody) {
      sym.superclass = sym.superclass || this.syms.objectType;
    } else if (sym.isEnum()) {
      sym.superclass = new T.ClassType(this.syms.symOf('java.lang.Enum'), [this.thisTypeOf(sym)], null);
    } else if (sym.isRecord()) {
      sym.superclass = this.syms.typeOf('java.lang.Record');
    } else if (decl && decl.isEnumConstantBody) {
      sym.superclass = sym.superclass || this.syms.objectType;
    } else {
      sym.superclass = this.syms.objectType;
    }
    if (sym.isInterface() && !isObject) sym.superclass = this.syms.objectType;
    sym.interfaces = [];
    if (decl && !decl.anonymous) {
      for (const i of decl.implementing || []) sym.interfaces.push(this.resolveType(i, env));
    } else if (decl && decl.anonymous && sym.anonInterface) {
      sym.interfaces.push(sym.anonInterface);
    }
    if (sym.isAnnotation()) sym.interfaces.push(this.syms.typeOf('java.lang.annotation.Annotation'));
    if (decl) sym.permitted = (decl.permitting || []).map((p) => this.resolveType(p, env));
    sym.thisType = this.thisTypeOf(sym);
    sym.headerState = 2;
  }

  thisTypeOf(sym) {
    if (sym.thisType) return sym.thisType;
    const tps = sym.typarams || [];
    let outer = null;
    const oc = sym.outerClassForTypeParams && sym.hasOuterThis ? this.enclosingClassOf(sym) : null;
    if (oc) {
      this.completeHeader(oc);
      const ot = this.thisTypeOf(oc);
      if (ot.args.length || (ot.outer && this.types.isParameterizedOuter(ot.outer))) outer = ot;
    }
    if (!tps.length && !outer) return this.syms.erasedType(sym);
    const t = new T.ClassType(sym, tps.slice(), outer);
    if (sym.headerState === 2) sym.thisType = t;
    return t;
  }

  enclosingClassOf(sym) {
    let o = sym.owner;
    while (o && o.kind !== 'class') o = o.owner;
    return o;
  }

  // ---- member completion -----------------------------------------------------
  completeMembers(sym) {
    if (sym.membersState !== 0) return;
    this.completeHeader(sym);
    sym.membersState = 1;
    const decl = sym.tree;
    const env = this.classEnv(sym);
    if (!decl) { sym.membersState = 2; return; }
    let hasCtor = false;
    const isIface = sym.isInterface();
    // record components become private final fields
    if (sym.isRecord()) {
      sym.recordComponents = [];
      for (const comp of decl.components) {
        const type = this.resolveType(comp.vartype, env);
        const f = new VarSymbol(comp.name, F.PRIVATE | F.FINAL, sym, type);
        f.isField = true;
        f.tree = comp;
        f.isRecordComponent = true;
        f.annotations = comp.mods.annotations;
        sym.addMember(f);
        sym.recordComponents.push(f);
        comp.sym = f;
      }
    }
    for (const d of decl.defs) {
      if (d.tag === 'VarDecl') {
        let flags = d.mods.flags;
        if (isIface) flags |= F.PUBLIC | F.STATIC | F.FINAL;
        let type;
        if (d.enumConstant) {
          type = this.syms.erasedType(sym);
          flags |= F.PUBLIC | F.STATIC | F.FINAL | F.ENUM;
        } else type = this.resolveType(d.vartype, env);
        const f = new VarSymbol(d.name, flags & ~(F.DEFAULT | F.SEALED | F.NON_SEALED), sym, type);
        f.isField = true;
        f.tree = d;
        f.env = env;
        if (d.init) f.flags |= F.HAS_INIT;
        if (d.mods.annotations.some((a) => qualifiedName(a.annotationType).endsWith('Deprecated'))) f.flags |= F.DEPRECATED;
        d.sym = f;
        sym.addMember(f);
      } else if (d.tag === 'MethodDecl') {
        const m = this.enterMethod(d, sym, env);
        if (m.isConstructor) hasCtor = true;
      }
    }
    if (sym.isRecord()) this.addRecordMembers(sym, decl, env);
    if (sym.isEnum()) this.addEnumMembers(sym);
    if (!hasCtor && !isIface && !(sym.isRecord())) this.addDefaultConstructor(sym);
    sym.membersState = 2;
  }

  enterMethod(d, sym, classEnv) {
    let flags = d.mods.flags;
    const isIface = sym.isInterface();
    if (isIface) {
      if (!(flags & (F.STATIC | F.DEFAULT | F.PRIVATE)) && !d.body) flags |= F.ABSTRACT;
      if (!(flags & F.PRIVATE)) flags |= F.PUBLIC;
    }
    if (sym.isAnnotation()) flags |= F.ABSTRACT | F.PUBLIC;
    if (d.name === '<init>' && sym.isEnum()) {
      flags = (flags & ~(F.PUBLIC | F.PROTECTED)) | F.PRIVATE;
    }
    if (d.params.length && d.params[d.params.length - 1].varargs) flags |= F.VARARGS;
    if (d.mods.annotations.some((a) => qualifiedName(a.annotationType).endsWith('Deprecated'))) flags |= F.DEPRECATED;
    const m = new MethodSymbol(d.name, flags & ~(F.SEALED | F.NON_SEALED), sym, null);
    m.tree = d;
    d.sym = m;
    const menv = classEnv.dup('method');
    menv.method = m;
    menv.isStatic = (flags & F.STATIC) !== 0;
    const typarams = [];
    for (const tp of d.typarams || []) {
      const tv = new T.TypeVar(tp.name, m);
      typarams.push(tv);
      menv.addTypeVar(tv);
    }
    for (let i = 0; i < typarams.length; i++) {
      const tp = d.typarams[i];
      typarams[i].bounds = tp.bounds.length ? tp.bounds.map((b) => this.resolveType(b, menv)) : [this.syms.objectType];
    }
    let params;
    if (d.compact) {
      // compact canonical constructor: parameters are the record components
      params = sym.recordComponents.map((c) => {
        const p = new VarSymbol(c.name, F.MANDATED, m, c.type);
        p.isParam = true;
        p.isLocal = true;
        return p;
      });
      m.flags |= F.COMPACT_RECORD_CONSTRUCTOR;
      if (!(m.flags & (F.PUBLIC | F.PROTECTED | F.PRIVATE))) m.flags |= sym.flags & (F.PUBLIC | F.PROTECTED | F.PRIVATE);
    } else {
      params = d.params.map((p) => {
        const ps = new VarSymbol(p.name, p.mods.flags & (F.FINAL), m, this.resolveType(p.vartype, menv));
        ps.isParam = true;
        ps.isLocal = true;
        ps.tree = p;
        p.sym = ps;
        return ps;
      });
    }
    m.params = params;
    const ret = d.restype ? this.resolveType(d.restype, menv) : T.PRIM.void;
    const thrown = d.thrown.map((t) => this.resolveType(t, menv));
    m.type = new T.MethodType(params.map((p) => p.type), ret, thrown, typarams);
    m.env = menv;
    sym.addMember(m);
    return m;
  }

  addDefaultConstructor(sym) {
    let flags = sym.flags & (F.PUBLIC | F.PROTECTED | F.PRIVATE);
    if (sym.isEnum()) flags = F.PRIVATE;
    if (sym.isAnonymous) flags = 0;
    const m = new MethodSymbol('<init>', flags | F.GENERATED_CONSTRUCTOR, sym, new T.MethodType([], T.PRIM.void, [], []));
    m.params = [];
    sym.addMember(m);
    sym.defaultCtor = m;
  }

  addEnumMembers(sym) {
    const et = this.syms.erasedType(sym);
    if (!sym.getMembers('values').some((m) => m.kind === 'method' && m.params.length === 0)) {
      const values = new MethodSymbol('values', F.PUBLIC | F.STATIC, sym, new T.MethodType([], new T.ArrayType(et), [], []));
      values.params = [];
      values.syntheticKind = 'enumValues';
      sym.addMember(values);
    }
    const strT = this.syms.typeOf('java.lang.String');
    const valueOf = new MethodSymbol('valueOf', F.PUBLIC | F.STATIC, sym, new T.MethodType([strT], et, [], []));
    const p = new VarSymbol('name', F.MANDATED, valueOf, strT);
    p.isParam = true;
    valueOf.params = [p];
    valueOf.syntheticKind = 'enumValueOf';
    sym.addMember(valueOf);
  }

  addRecordMembers(sym, decl, env) {
    const comps = sym.recordComponents;
    // canonical constructor
    const hasCanonical = sym.getMembers('<init>').some((m) => m.kind === 'method' && m.params.length === comps.length &&
      m.params.every((p, i) => this.types.isSameType(this.types.erasure(p.type), this.types.erasure(comps[i].type))));
    if (!hasCanonical) {
      const m = new MethodSymbol('<init>', (sym.flags & (F.PUBLIC | F.PROTECTED | F.PRIVATE)) | F.GENERATED_CONSTRUCTOR, sym,
        new T.MethodType(comps.map((c) => c.type), T.PRIM.void, [], []));
      m.params = comps.map((c) => {
        const p = new VarSymbol(c.name, F.MANDATED, m, c.type);
        p.isParam = true;
        p.isLocal = true;
        return p;
      });
      m.syntheticKind = 'recordCanonical';
      if (comps.length && comps[comps.length - 1].tree.varargs) m.flags |= F.VARARGS;
      sym.addMember(m);
    } else {
      for (const m of sym.getMembers('<init>')) {
        if (m.params.length === comps.length && m.params.every((p, i) => this.types.isSameType(this.types.erasure(p.type), this.types.erasure(comps[i].type)))) {
          m.isCanonical = true;
          if (comps.length && comps[comps.length - 1].tree.varargs) m.flags |= F.VARARGS;
        }
      }
    }
    for (const c of comps) {
      if (!sym.getMembers(c.name).some((m) => m.kind === 'method' && m.params.length === 0)) {
        const acc = new MethodSymbol(c.name, F.PUBLIC, sym, new T.MethodType([], c.type, [], []));
        acc.params = [];
        acc.syntheticKind = 'recordAccessor';
        acc.component = c;
        sym.addMember(acc);
      }
    }
    const obj = this.syms.objectType;
    const str = this.syms.typeOf('java.lang.String');
    const addIfMissing = (name, params, ret) => {
      const exists = sym.getMembers(name).some((m) => m.kind === 'method' && m.params.length === params.length &&
        m.params.every((p, i) => this.types.isSameType(this.types.erasure(p.type), params[i])));
      if (exists) return;
      const m = new MethodSymbol(name, F.PUBLIC | F.FINAL, sym, new T.MethodType(params, ret, [], []));
      m.params = params.map((t, i) => {
        const p = new VarSymbol(`o${i}`, 0, m, t);
        p.isParam = true;
        return p;
      });
      m.syntheticKind = 'recordObjectMethod';
      sym.addMember(m);
    };
    addIfMissing('toString', [], str);
    addIfMissing('hashCode', [], T.PRIM.int);
    addIfMissing('equals', [obj], T.PRIM.boolean);
  }

  // ---- type resolution ----------------------------------------------------------
  resolveType(tree, env) {
    switch (tree.tag) {
      case 'PrimitiveType': return T.PRIM[tree.typetag];
      case 'ArrayType': return new T.ArrayType(this.resolveType(tree.elemtype, env));
      case 'AnnotatedType': return this.resolveType(tree.underlying, env);
      case 'Wildcard':
        return new T.WildcardType(tree.kind, tree.bound ? this.resolveType(tree.bound, env) : null);
      case 'TypeUnion': {
        const alts = tree.alternatives.map((a) => this.resolveType(a, env));
        return new T.UnionType(alts, this.types.lub(alts));
      }
      case 'TypeIntersection':
        return new T.IntersectionType(tree.bounds.map((b) => this.resolveType(b, env)));
      case 'TypeApply': {
        const base = this.resolveType(tree.clazz, env);
        if (base.kind !== 'class') this.error('type arguments on a non-class type', env.unit, tree.pos);
        const args = tree.args.map((a) => this.resolveType(a, env));
        return new T.ClassType(base.sym, args, base.outer);
      }
      case 'Ident': {
        const t = this.findType(tree.name, env);
        if (!t) this.error(`cannot find symbol: class ${tree.name}`, env.unit, tree.pos);
        tree.type = t;
        return t;
      }
      case 'Select': {
        const site = this.resolveTypeOrPackage(tree.selected, env);
        if (!site) this.error(`cannot find symbol: ${qualifiedName(tree.selected)}`, env.unit, tree.pos);
        if (site.kind === 'package') {
          const c = this.syms.findTopLevel(site.sym.fullName, tree.name);
          if (!c) this.error(`cannot find symbol: class ${site.sym.fullName}.${tree.name}`, env.unit, tree.pos);
          return this.syms.erasedType(c);
        }
        if (site.kind === 'class') {
          const c = this.findMemberType(site.sym, tree.name);
          if (!c) this.error(`cannot find symbol: class ${tree.name} in ${site.sym.fullName}`, env.unit, tree.pos);
          return this.memberClassType(site, c);
        }
        if (site.kind === 'tvar') {
          // T.Inner: member type of the type variable's bound
          const b = this.types.erasure(site);
          const c = this.findMemberType(b.sym, tree.name);
          if (c) return this.syms.erasedType(c);
        }
        this.error(`cannot select from ${T.typeToString(site)}`, env.unit, tree.pos);
        break;
      }
      default:
        this.error(`unexpected type tree ${tree.tag}`, env.unit, tree.pos);
    }
    return null;
  }

  // A member class type seen through a qualifying site type.
  memberClassType(site, c) {
    this.completeHeader(c);
    if (!(c.flags & F.STATIC) && c.hasOuterThis && site.kind === 'class' && (site.args.length || (site.outer && this.types.isParameterizedOuter(site.outer)))) {
      return new T.ClassType(c, [], site);
    }
    return this.syms.erasedType(c);
  }

  resolveTypeOrPackage(tree, env) {
    if (tree.tag === 'Ident') {
      const t = this.findType(tree.name, env);
      if (t) return t;
      if (this.syms.packageExists(tree.name)) return new T.PackageType(this.syms.enterPackage(tree.name));
      return null;
    }
    if (tree.tag === 'Select') {
      const site = this.resolveTypeOrPackage(tree.selected, env);
      if (!site) return null;
      if (site.kind === 'package') {
        const c = this.syms.findTopLevel(site.sym.fullName, tree.name);
        if (c) return this.syms.erasedType(c);
        const pn = `${site.sym.fullName}.${tree.name}`;
        if (this.syms.packageExists(pn)) return new T.PackageType(this.syms.enterPackage(pn));
        return null;
      }
      if (site.kind === 'class') {
        const c = this.findMemberType(site.sym, tree.name);
        return c ? this.memberClassType(site, c) : null;
      }
      return null;
    }
    if (tree.tag === 'TypeApply' || tree.tag === 'AnnotatedType') return this.resolveType(tree, env);
    return null;
  }

  // Member type lookup including inherited member types. A member type
  // declared in a class hides same-named types of its supertypes, and private
  // member types are not inherited (JLS 8.5).
  findMemberType(c, name) {
    const direct = c.memberClasses.get(name);
    if (direct) return direct;
    if (c.headerState === 1) {
      // header in progress (resolving our own supertypes): only declared members
      return null;
    }
    this.completeHeader(c);
    const seen = new Set();
    const HIDDEN = {};
    const go = (s, top) => {
      if (!s || seen.has(s)) return null;
      seen.add(s);
      const d = s.memberClasses.get(name);
      if (d) return (!top && (d.flags & F.PRIVATE)) ? HIDDEN : d;
      if (s.headerState === 1) return null;
      this.completeHeader(s);
      let found = null;
      if (s.superclass && s.superclass.kind === 'class') {
        const r = go(s.superclass.sym, false);
        if (r && r !== HIDDEN) return r;
      }
      for (const i of s.interfaces || []) {
        if (i.kind !== 'class') continue;
        const r = go(i.sym, false);
        if (r && r !== HIDDEN) return r;
      }
      return found;
    };
    const r = go(c, true);
    return r === HIDDEN ? null : r;
  }

  // Resolve a simple type name in env (JLS 6.5.5.1).
  findType(name, env) {
    for (let e = env; e; e = e.outer) {
      if (e.localClasses && e.localClasses.has(name)) return this.syms.erasedType(e.localClasses.get(name));
      if (e.typeVars && e.typeVars.has(name)) return e.typeVars.get(name);
      if (e.kind === 'class' && e.clazz) {
        const c = e.clazz;
        if (c.name === name && c.isLocal && !c.isAnonymous) {
          // a local class can name itself
        }
        const m = this.findMemberType(c, name);
        if (m) return this.implicitMemberClassType(m, env);
        if (c.name === name && !c.isAnonymous) return this.syms.erasedType(c);
      }
      if (e.kind === 'unit') return this.findGlobalType(name, e.unit);
    }
    return null;
  }

  // An inner class named without qualification inside a generic outer class
  // implicitly has the outer this-type as its outer type.
  implicitMemberClassType(m, env) {
    if (m.flags & F.STATIC || !m.hasOuterThis) return this.syms.erasedType(m);
    const owner = m.owner;
    if (owner.kind !== 'class') return this.syms.erasedType(m);
    this.completeHeader(owner);
    // find an enclosing env class that is (a subclass of) owner, in a non-static context
    for (let e = env; e; e = e.outer) {
      if (e.kind === 'class' && e.clazz) {
        if (this.syms.isSubClass(e.clazz, owner)) {
          const ot = this.thisTypeOf(e.clazz);
          const sup = this.types.asSuper(ot, owner);
          if (sup && (sup.args.length || (sup.outer && this.types.isParameterizedOuter(sup.outer)))) return new T.ClassType(m, [], sup);
          return this.syms.erasedType(m);
        }
      }
    }
    return this.syms.erasedType(m);
  }

  findGlobalType(name, unit) {
    // same compilation unit
    const own = unit.topLevel.get(name);
    if (own) return this.syms.erasedType(own);
    // single type import
    if (unit.singleImports.has(name)) {
      let c = unit.resolvedSingle.get(name);
      if (c === undefined) {
        c = this.syms.findClassByName(unit.singleImports.get(name));
        unit.resolvedSingle.set(name, c || null);
      }
      if (c) return this.syms.erasedType(c);
    }
    // same package
    const c = this.syms.findTopLevel(unit.pkg.fullName, name);
    if (c) return this.syms.erasedType(c);
    // on demand imports
    for (const q of unit.onDemand) {
      if (this.syms.packageExists(q)) {
        const d = this.syms.findTopLevel(q, name);
        // only accessible types are imported on demand (JLS 7.5.2)
        if (d && ((d.flags & F.PUBLIC) || q === unit.pkg.fullName)) return this.syms.erasedType(d);
      }
      const owner = this.syms.findClassByName(q);
      if (owner) {
        // `import T.*` imports the member types declared in T, not inherited ones
        const m = owner.memberClasses.get(name);
        if (m) return this.syms.erasedType(m);
      }
    }
    // java.lang
    const jl = this.syms.findTopLevel('java.lang', name);
    if (jl) return this.syms.erasedType(jl);
    // static imports of member types
    for (const si of unit.staticSingle) {
      if (si.name !== name) continue;
      const owner = this.syms.findClassByName(si.owner);
      if (owner) {
        const m = this.findMemberType(owner, name);
        if (m) return this.syms.erasedType(m);
      }
    }
    for (const q of unit.staticOnDemand) {
      const owner = this.syms.findClassByName(q);
      if (owner) {
        const m = this.findMemberType(owner, name);
        if (m) return this.syms.erasedType(m);
      }
    }
    return null;
  }
}

module.exports = { Enter, Env, UnitInfo, CompileError, qualifiedName };
