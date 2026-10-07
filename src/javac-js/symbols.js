'use strict';

// Symbols (packages, classes, methods, variables) and the symbol table that
// loads classes from source roots on demand.

const fs = require('fs');
const path = require('path');
const { F } = require('./flags');
const T = require('./types');

class Symbol {
  constructor(kind, name, flags, owner) {
    this.kind = kind; // 'pkg' | 'class' | 'method' | 'var' | 'tvar'
    this.name = name;
    this.flags = flags || 0;
    this.owner = owner || null;
  }
  isStatic() { return (this.flags & F.STATIC) !== 0; }
  isPrivate() { return (this.flags & F.PRIVATE) !== 0; }
  isAbstract() { return (this.flags & F.ABSTRACT) !== 0; }
  // the class this symbol belongs to (or itself)
  enclClass() {
    let s = this;
    while (s && s.kind !== 'class') s = s.owner;
    return s;
  }
  packge() {
    let s = this;
    while (s && s.kind !== 'pkg') s = s.owner;
    return s;
  }
}

class PackageSymbol extends Symbol {
  constructor(fullName, owner) {
    super('pkg', fullName.split('.').pop(), 0, owner);
    this.fullName = fullName;
    this.classes = new Map(); // simple name -> ClassSymbol (top level)
    this.exists = false;
    this.listed = false;
  }
  binaryName() { return this.fullName.replace(/\./g, '/'); }
}

class ClassSymbol extends Symbol {
  constructor(name, flags, owner) {
    super('class', name, flags, owner);
    this.classKind = 'class';
    this.typarams = null;
    this.superclass = null;
    this.interfaces = null;
    this.permitted = [];
    this.members = new Map(); // name -> [Symbol]  (fields, methods, member classes)
    this.memberClasses = new Map(); // name -> ClassSymbol
    this.tree = null;
    this.cu = null;
    this.env = null;
    this.headerState = 0; // 0 none, 1 in progress, 2 done
    this.membersState = 0;
    this.thisType = null;
    this.flatName = null;
    this.fullName = null;
    this.localIndex = 0;
    this.isLocal = false;
    this.isAnonymous = false;
    this.hasOuterThis = false;
    this.nestHost = null;
    this.nestMembers = [];
    this.innerClassesUsed = new Set();
    this.recordComponents = null;
    this.trans = {}; // lowering state
  }
  isInterface() { return (this.flags & F.INTERFACE) !== 0; }
  isEnum() { return (this.flags & F.ENUM) !== 0; }
  isRecord() { return (this.flags & F.RECORD) !== 0; }
  isAnnotation() { return (this.flags & F.ANNOTATION) !== 0; }
  isInner() {
    // non-static nested class with an enclosing instance
    return this.hasOuterThis;
  }
  binaryName() { return this.flatName.replace(/\./g, '/'); }
  // enclosing class whose type parameters are visible to this one
  outerClassForTypeParams() {
    if (this.flags & F.STATIC) return null;
    let o = this.owner;
    while (o && o.kind !== 'class') {
      if (o.kind === 'method' && (o.flags & F.STATIC)) {
        // local class in static method still sees the method's type vars, but not the class's
        return null;
      }
      o = o.owner;
    }
    if (!o || o.kind !== 'class') return null;
    if (this.isInterface() || this.isEnum() || this.isRecord()) return null;
    return o;
  }
  addMember(sym) {
    let list = this.members.get(sym.name);
    if (!list) { list = []; this.members.set(sym.name, list); }
    list.push(sym);
  }
  getMembers(name) { return this.members.get(name) || []; }
  toString() { return this.fullName; }
}

class MethodSymbol extends Symbol {
  constructor(name, flags, owner, type) {
    super('method', name, flags, owner);
    this.type = type; // MethodType
    this.params = [];
    this.tree = null;
    this.defaultValue = null;
    this.isConstructor = name === '<init>';
  }
  toString() { return `${this.owner ? this.owner.fullName : '?'}.${this.name}${this.type ? T.typeToString(this.type) : ''}`; }
}

class VarSymbol extends Symbol {
  constructor(name, flags, owner, type) {
    super('var', name, flags, owner);
    this.type = type;
    this.tree = null;
    this.constValue = undefined; // undefined = not computed, null = not constant
    this.adr = -1;
    this.isLocal = false;
    this.isField = false;
    this.isParam = false;
  }
  toString() { return this.name; }
}

// ---------------------------------------------------------------------------

class Symtab {
  constructor(options) {
    this.options = options || {};
    this.sourceRoots = (this.options.sourceRoots || []).map((r) => path.resolve(r));
    this.packages = new Map();
    this.classes = new Map(); // flat name -> ClassSymbol (top level and members)
    this.parseFile = this.options.parseFile;
    this.enterUnit = null; // set by Enter
    this.completeHeaderHook = null; // set by Enter
    this.completeMembersHook = null;
    this.unitsByFile = new Map();
    this.rootPackage = this.enterPackage('');
    this.erasedCache = new Map();
    this._objectSym = null;
    this.types = new T.Types(this);
  }

  // ---- packages ------------------------------------------------------
  enterPackage(fullName) {
    let p = this.packages.get(fullName);
    if (!p) {
      const ownerName = fullName.includes('.') ? fullName.slice(0, fullName.lastIndexOf('.')) : '';
      const owner = fullName === '' ? null : this.enterPackage(ownerName);
      p = new PackageSymbol(fullName, owner);
      this.packages.set(fullName, p);
    }
    return p;
  }

  packageExists(fullName) {
    const p = this.enterPackage(fullName);
    if (p.exists) return true;
    if (p.classes.size) { p.exists = true; return true; }
    // a package of the compiled files themselves, or an enclosing package of one
    const prefix = `${fullName}.`;
    for (const [n, q] of this.packages) {
      if (q.classes.size && n.startsWith(prefix)) { p.exists = true; return true; }
    }
    const rel = fullName.replace(/\./g, '/');
    for (const r of this.sourceRoots) {
      try {
        if (fs.statSync(path.join(r, rel)).isDirectory()) { p.exists = true; return true; }
      } catch (e) { /* missing */ }
    }
    return false;
  }

  // ---- class lookup ----------------------------------------------------
  // Find a top-level class by package and simple name, loading its source file if needed.
  findTopLevel(pkgName, simpleName) {
    const p = this.enterPackage(pkgName);
    let c = p.classes.get(simpleName);
    if (c) return c;
    const rel = (pkgName ? pkgName.replace(/\./g, '/') + '/' : '') + simpleName + '.java';
    for (const r of this.sourceRoots) {
      const f = path.join(r, rel);
      if (this.unitsByFile.has(f)) continue;
      if (fs.existsSync(f)) {
        this.loadSourceFile(f);
        c = p.classes.get(simpleName);
        if (c) return c;
      }
    }
    return null;
  }

  loadSourceFile(file) {
    if (this.unitsByFile.has(file)) return this.unitsByFile.get(file);
    const src = fs.readFileSync(file, 'utf8');
    const cu = this.parseFile(src, file);
    this.unitsByFile.set(file, cu);
    this.enterUnit(cu);
    return cu;
  }

  addUnit(cu) {
    if (cu.file) this.unitsByFile.set(cu.file, cu);
    this.enterUnit(cu);
  }

  // Look up a class by fully qualified canonical name (dots everywhere).
  findClassByName(fullName) {
    const parts = fullName.split('.');
    // try longest package prefix first
    for (let k = parts.length - 1; k >= 0; k--) {
      const pkg = parts.slice(0, k).join('.');
      if (k > 0 && !this.packageExists(pkg)) continue;
      let c = this.findTopLevel(pkg, parts[k]);
      if (!c) continue;
      for (let j = k + 1; j < parts.length && c; j++) c = this.findMemberClass(c, parts[j]);
      if (c) return c;
    }
    return null;
  }

  findMemberClass(c, name) {
    return c.memberClasses.get(name) || null;
  }

  get objectSym() {
    if (!this._objectSym) {
      this._objectSym = this.findClassByName('java.lang.Object');
      if (!this._objectSym) throw new Error('cannot find java.lang.Object on the source path');
    }
    return this._objectSym;
  }

  get objectType() { return this.erasedType(this.objectSym); }

  typeOf(fullName) {
    const c = this.findClassByName(fullName);
    if (!c) throw new Error(`cannot find class ${fullName}`);
    return this.erasedType(c);
  }

  symOf(fullName) {
    const c = this.findClassByName(fullName);
    if (!c) throw new Error(`cannot find class ${fullName}`);
    return c;
  }

  erasedType(sym) {
    let t = this.erasedCache.get(sym);
    if (!t) {
      t = new T.ClassType(sym, [], null);
      t.erased = true;
      this.erasedCache.set(sym, t);
    }
    return t;
  }

  completeHeader(sym) {
    if (sym.headerState === 0 && this.completeHeaderHook) this.completeHeaderHook(sym);
    return sym;
  }

  completeMembers(sym) {
    this.completeHeader(sym);
    if (sym.membersState === 0 && this.completeMembersHook) this.completeMembersHook(sym);
    return sym;
  }

  // is class c a subclass (or subinterface, or same) of d (erased)?
  isSubClass(c, d) {
    if (c === d) return true;
    const seen = new Set();
    const go = (s) => {
      if (!s || seen.has(s)) return false;
      if (s === d) return true;
      seen.add(s);
      this.completeHeader(s);
      if (s.superclass && go(s.superclass.sym)) return true;
      for (const i of s.interfaces || []) if (i.kind === 'class' && go(i.sym)) return true;
      return false;
    };
    return go(c);
  }
}

module.exports = { Symbol, PackageSymbol, ClassSymbol, MethodSymbol, VarSymbol, Symtab };
