'use strict';

// Type model and type relations (JLS chapter 4 and 5) as needed to compile
// valid programs: erasure, substitution, subtyping with wildcards and
// capture, asSuper, boxing, numeric promotion, lub (approximate),
// descriptors and generic signatures.

const PRIM_TAGS = ['boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double', 'void'];

class Type {
  constructor(kind) { this.kind = kind; }
  isPrimitive() { return this.kind === 'prim' && this.tag !== 'void'; }
  isReference() { return this.kind === 'class' || this.kind === 'array' || this.kind === 'tvar' || this.kind === 'null' || this.kind === 'intersection'; }
  toString() { return typeToString(this); }
}

class PrimType extends Type {
  constructor(tag) { super('prim'); this.tag = tag; }
}

class ClassType extends Type {
  constructor(sym, args, outer) {
    super('class');
    this.sym = sym;
    this.args = args || [];
    this.outer = outer || null;
  }
}

class ArrayType extends Type {
  constructor(elem) { super('array'); this.elem = elem; }
}

let tvarCounter = 0;
class TypeVar extends Type {
  constructor(name, owner) {
    super('tvar');
    this.name = name;
    this.owner = owner; // ClassSymbol or MethodSymbol
    this.bounds = null; // upper bounds (array), filled when the declaration is completed
    this.lower = null; // lower bound for captured variables
    this.id = ++tvarCounter;
  }
  upperBound() {
    if (!this.bounds || this.bounds.length === 0) return null;
    return this.bounds.length === 1 ? this.bounds[0] : new IntersectionType(this.bounds);
  }
}

class CapturedTypeVar extends TypeVar {
  constructor(wildcard, formal) {
    super(`capture of ${typeToString(wildcard)}`, null);
    this.captured = true;
    this.wildcard = wildcard;
    this.formal = formal;
  }
}

class WildcardType extends Type {
  constructor(bk, bound) {
    super('wildcard');
    this.bk = bk; // 'extends' | 'super' | 'unbound'
    this.bound = bound || null;
  }
}

class IntersectionType extends Type {
  constructor(bounds) { super('intersection'); this.bounds = bounds; }
}

class UnionType extends Type {
  constructor(alternatives, lub) { super('union'); this.alternatives = alternatives; this.lub = lub; }
}

class MethodType extends Type {
  constructor(params, ret, thrown, typarams) {
    super('method');
    this.params = params;
    this.ret = ret;
    this.thrown = thrown || [];
    this.typarams = typarams || []; // TypeVars of a generic method
  }
}

class NullType extends Type { constructor() { super('null'); } }
class UnknownType extends Type { constructor() { super('unknown'); } }
class PackageType extends Type { constructor(sym) { super('package'); this.sym = sym; } }

const PRIM = {};
for (const t of PRIM_TAGS) PRIM[t] = new PrimType(t);
const NULL = new NullType();
const UNKNOWN = new UnknownType();

const BOX_NAMES = {
  boolean: 'java.lang.Boolean', byte: 'java.lang.Byte', short: 'java.lang.Short', char: 'java.lang.Character',
  int: 'java.lang.Integer', long: 'java.lang.Long', float: 'java.lang.Float', double: 'java.lang.Double', void: 'java.lang.Void',
};
const UNBOX = {};
for (const [p, c] of Object.entries(BOX_NAMES)) if (p !== 'void') UNBOX[c] = p;

const DESC = { boolean: 'Z', byte: 'B', short: 'S', char: 'C', int: 'I', long: 'J', float: 'F', double: 'D', void: 'V' };

// numeric rank for widening (JLS 5.1.2)
const WIDENING = {
  byte: ['short', 'int', 'long', 'float', 'double'],
  short: ['int', 'long', 'float', 'double'],
  char: ['int', 'long', 'float', 'double'],
  int: ['long', 'float', 'double'],
  long: ['float', 'double'],
  float: ['double'],
  double: [],
  boolean: [],
};

function isNumericTag(tag) {
  return tag === 'byte' || tag === 'short' || tag === 'char' || tag === 'int' || tag === 'long' || tag === 'float' || tag === 'double';
}

function isIntegralTag(tag) {
  return tag === 'byte' || tag === 'short' || tag === 'char' || tag === 'int' || tag === 'long';
}

function typeToString(t) {
  if (!t) return '<null>';
  switch (t.kind) {
    case 'prim': return t.tag;
    case 'class': {
      const base = t.outer && t.outer.kind === 'class' && t.outer.args.length ? `${typeToString(t.outer)}.${t.sym.name}` : t.sym.fullName;
      return t.args.length ? `${base}<${t.args.map(typeToString).join(',')}>` : base;
    }
    case 'array': return `${typeToString(t.elem)}[]`;
    case 'tvar': return t.captured ? `capture#${t.id} of ${typeToString(t.wildcard)}` : t.name;
    case 'wildcard': return t.bk === 'unbound' ? '?' : `? ${t.bk} ${typeToString(t.bound)}`;
    case 'intersection': return t.bounds.map(typeToString).join('&');
    case 'union': return t.alternatives.map(typeToString).join('|');
    case 'method': return `(${t.params.map(typeToString).join(',')})${typeToString(t.ret)}`;
    case 'null': return 'null';
    case 'unknown': return '<any>';
    case 'package': return `package ${t.sym.fullName}`;
    default: return `<${t.kind}>`;
  }
}

// ---------------------------------------------------------------------------
// The Types object needs the symbol table to find java.lang.Object etc.
class Types {
  constructor(symtab) {
    this.syms = symtab;
  }

  get objectType() { return this.syms.objectType; }

  classType(name) { return this.syms.typeOf(name); }

  // ---- erasure -------------------------------------------------------
  erasure(t) {
    if (!t) return t;
    switch (t.kind) {
      case 'class':
        if (t.args.length === 0 && (!t.outer || !this.isParameterizedOuter(t.outer))) return t.erased ? t : this.syms.erasedType(t.sym);
        return this.syms.erasedType(t.sym);
      case 'array': {
        const e = this.erasure(t.elem);
        return e === t.elem ? t : new ArrayType(e);
      }
      case 'tvar': {
        const ub = t.bounds && t.bounds.length ? t.bounds[0] : this.objectType;
        return this.erasure(ub);
      }
      case 'intersection': return this.erasure(t.bounds[0]);
      case 'union': return this.erasure(t.lub || this.objectType);
      case 'wildcard': return this.erasure(t.bk === 'extends' ? t.bound : this.objectType);
      case 'method':
        return new MethodType(t.params.map((p) => this.erasure(p)), this.erasure(t.ret), t.thrown.map((p) => this.erasure(p)), []);
      default: return t;
    }
  }

  isParameterizedOuter(o) {
    while (o && o.kind === 'class') {
      if (o.args.length) return true;
      o = o.outer;
    }
    return false;
  }

  isRaw(t) {
    if (t.kind !== 'class') return t.kind === 'array' && this.isRaw(t.elem);
    if (t.args.length) return false;
    const tps = this.syms.completeHeader(t.sym).typarams;
    if (tps && tps.length) return true;
    // inner class of a raw generic outer
    if (t.outer && t.outer.kind === 'class' && !(t.sym.flags & 0x0008)) return this.isRaw(t.outer);
    return false;
  }

  // ---- substitution ----------------------------------------------------
  // from: TypeVar[], to: Type[]
  subst(t, from, to) {
    if (!t || from.length === 0) return t;
    switch (t.kind) {
      case 'tvar': {
        for (let i = 0; i < from.length; i++) if (from[i] === t) return to[i];
        return t;
      }
      case 'class': {
        if (t.args.length === 0 && !t.outer) return t;
        let changed = false;
        const args = t.args.map((a) => { const s = this.subst(a, from, to); if (s !== a) changed = true; return s; });
        const outer = t.outer ? this.subst(t.outer, from, to) : null;
        if (outer !== t.outer) changed = true;
        return changed ? new ClassType(t.sym, args, outer) : t;
      }
      case 'array': {
        const e = this.subst(t.elem, from, to);
        return e === t.elem ? t : new ArrayType(e);
      }
      case 'wildcard': {
        if (!t.bound) return t;
        const b = this.subst(t.bound, from, to);
        return b === t.bound ? t : new WildcardType(t.bk, b);
      }
      case 'intersection': return new IntersectionType(t.bounds.map((b) => this.subst(b, from, to)));
      case 'method': {
        // generic method type params are not substituted unless listed
        const nt = new MethodType(t.params.map((p) => this.subst(p, from, to)), this.subst(t.ret, from, to), t.thrown.map((p) => this.subst(p, from, to)), t.typarams);
        return nt;
      }
      default: return t;
    }
  }

  // ---- supertype navigation ------------------------------------------
  // Direct supertypes of t (with type arguments substituted).
  supertype(t) {
    if (t.kind === 'class') {
      const sym = this.syms.completeHeader(t.sym);
      if (!sym.superclass) return null;
      return this.substSuper(t, sym.superclass);
    }
    if (t.kind === 'array') {
      const e = t.elem;
      if (e.kind === 'prim' || this.isSameType(e, this.objectType)) return this.objectType;
      const se = this.supertype(e);
      return se ? new ArrayType(se) : this.objectType;
    }
    if (t.kind === 'tvar') return t.upperBound() || this.objectType;
    return null;
  }

  interfaces(t) {
    if (t.kind === 'class') {
      const sym = this.syms.completeHeader(t.sym);
      return (sym.interfaces || []).map((i) => this.substSuper(t, i));
    }
    if (t.kind === 'array') return [this.syms.typeOf('java.lang.Cloneable'), this.syms.typeOf('java.io.Serializable')];
    return [];
  }

  substSuper(t, sup) {
    const sym = t.sym;
    const tps = sym.typarams || [];
    if (this.isRaw(t)) return this.erasure(sup);
    let r = tps.length && t.args.length ? this.subst(sup, tps, t.args) : sup;
    // outer type parameters
    let o = t.outer;
    let os = sym.outerClassForTypeParams();
    while (o && o.kind === 'class' && os) {
      const otps = os.typarams || [];
      if (otps.length && o.args.length) r = this.subst(r, otps, o.args);
      o = o.outer;
      os = os.outerClassForTypeParams();
    }
    return r;
  }

  // Find the supertype of t whose symbol is sym (or null).
  asSuper(t, sym) {
    if (!t) return null;
    switch (t.kind) {
      case 'class': {
        if (t.sym === sym) return t;
        const seen = new Set();
        const go = (u) => {
          if (!u || u.kind !== 'class') return null;
          if (u.sym === sym) return u;
          if (seen.has(u.sym)) return null;
          seen.add(u.sym);
          const st = this.supertype(u);
          const r = st && go(st);
          if (r) return r;
          if (sym.isInterface() || true) {
            for (const i of this.interfaces(u)) {
              const ri = go(i);
              if (ri) return ri;
            }
          }
          return null;
        };
        return go(t);
      }
      case 'array':
        if (sym === this.syms.objectSym || sym.fullName === 'java.lang.Cloneable' || sym.fullName === 'java.io.Serializable') return this.syms.erasedType(sym);
        return null;
      case 'tvar':
        if (t.bounds) {
          for (const b of t.bounds) {
            const r = this.asSuper(b, sym);
            if (r) return r;
          }
        }
        return sym === this.syms.objectSym ? this.objectType : null;
      case 'intersection':
        for (const b of t.bounds) {
          const r = this.asSuper(b, sym);
          if (r) return r;
        }
        return null;
      case 'null': return null;
      default: return null;
    }
  }

  // asSuper that also looks through the enclosing classes (for inherited members of outer classes)
  asOuterSuper(t, sym) {
    let o = t;
    while (o && o.kind === 'class') {
      const s = this.asSuper(o, sym);
      if (s) return s;
      o = o.outer;
    }
    return null;
  }

  // ---- sameness and containment ----------------------------------------
  isSameType(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
      case 'prim': return a.tag === b.tag;
      case 'class':
        if (a.sym !== b.sym) return false;
        if (a.args.length !== b.args.length) return a.args.length === 0 || b.args.length === 0 ? false : false;
        for (let i = 0; i < a.args.length; i++) if (!this.isSameTypeArg(a.args[i], b.args[i])) return false;
        return true;
      case 'array': return this.isSameType(a.elem, b.elem);
      case 'tvar': return a === b;
      case 'wildcard': return a.bk === b.bk && (a.bk === 'unbound' || this.isSameType(a.bound, b.bound));
      case 'intersection': return a.bounds.length === b.bounds.length && a.bounds.every((x, i) => this.isSameType(x, b.bounds[i]));
      case 'null': return true;
      default: return false;
    }
  }

  isSameTypeArg(a, b) {
    if (a.kind === 'wildcard' || b.kind === 'wildcard') {
      if (a.kind !== b.kind) return false;
      const ab = a.bk === 'unbound' || (a.bk === 'extends' && this.isObject(a.bound));
      const bb = b.bk === 'unbound' || (b.bk === 'extends' && this.isObject(b.bound));
      if (ab && bb) return true;
      return this.isSameType(a, b);
    }
    return this.isSameType(a, b);
  }

  isObject(t) { return t && t.kind === 'class' && t.sym === this.syms.objectSym; }

  // JLS 4.5.1 type argument containment: does arg t contain s?
  containsType(t, s) {
    if (t.kind === 'wildcard') {
      if (t.bk === 'unbound') return true;
      if (t.bk === 'extends') {
        const sUpper = s.kind === 'wildcard' ? (s.bk === 'extends' ? s.bound : (s.bk === 'unbound' ? this.objectType : this.objectType)) : s;
        if (s.kind === 'wildcard' && s.bk === 'super') return this.isObject(t.bound);
        return this.isSubtype(sUpper, t.bound);
      }
      // super
      if (s.kind === 'wildcard') {
        if (s.bk !== 'super') return false;
        return this.isSubtype(t.bound, s.bound);
      }
      return this.isSubtype(t.bound, s);
    }
    if (s.kind === 'wildcard') return false;
    return this.isSameType(t, s) || this.isSameTypeLenient(t, s);
  }

  isSameTypeLenient(t, s) {
    // treat captured variables as equal to their wildcard source
    if (s.kind === 'tvar' && s.captured) return this.containsType(s.wildcard, t) && this.containsType(t, s.wildcard) || false;
    if (t.kind === 'tvar' && t.captured && s.kind !== 'tvar') return false;
    return false;
  }

  // ---- subtyping -------------------------------------------------------
  isSubtype(s, t, unchecked) {
    if (s === t) return true;
    if (!s || !t) return false;
    if (s.kind === 'unknown' || t.kind === 'unknown') return true;
    if (t.kind === 'prim' || s.kind === 'prim') {
      if (s.kind !== 'prim' || t.kind !== 'prim') return false;
      if (s.tag === t.tag) return true;
      return (WIDENING[s.tag] || []).includes(t.tag);
    }
    if (s.kind === 'null') return t.kind !== 'prim';
    if (t.kind === 'intersection') return t.bounds.every((b) => this.isSubtype(s, b, unchecked));
    if (t.kind === 'tvar') {
      if (s.kind === 'tvar' && s === t) return true;
      if (t.lower && this.isSubtype(s, t.lower, unchecked)) return true;
      if (s.kind === 'tvar' || s.kind === 'intersection') {
        // a type variable is a subtype of t only through its bounds
        const bounds = s.kind === 'tvar' ? (s.bounds || []) : s.bounds;
        return bounds.some((b) => this.isSubtype(b, t, unchecked));
      }
      return false;
    }
    if (t.kind === 'union') return t.alternatives.some((a) => this.isSubtype(s, a, unchecked));
    switch (s.kind) {
      case 'tvar':
        if (!s.bounds || s.bounds.length === 0) return this.isObject(t);
        return s.bounds.some((b) => this.isSubtype(b, t, unchecked));
      case 'intersection':
        return s.bounds.some((b) => this.isSubtype(b, t, unchecked));
      case 'union':
        return s.alternatives.every((a) => this.isSubtype(a, t, unchecked));
      case 'array':
        if (t.kind === 'array') {
          if (s.elem.kind === 'prim' || t.elem.kind === 'prim') return s.elem.kind === 'prim' && t.elem.kind === 'prim' && s.elem.tag === t.elem.tag;
          return this.isSubtype(s.elem, t.elem, unchecked);
        }
        if (t.kind === 'class') {
          const n = t.sym.fullName;
          return n === 'java.lang.Object' || n === 'java.lang.Cloneable' || n === 'java.io.Serializable';
        }
        return false;
      case 'class': {
        if (t.kind !== 'class') return false;
        const sup = this.asSuper(s, t.sym);
        if (!sup) return false;
        if (t.args.length === 0) return true;
        if (sup.args.length === 0) return !!unchecked || this.isRaw(sup) ? !!unchecked : true;
        if (sup.args.length !== t.args.length) return false;
        for (let i = 0; i < t.args.length; i++) {
          if (!this.containsType(t.args[i], sup.args[i])) {
            // captured type vars in sup are contained by their wildcard
            const a = sup.args[i];
            if (a.kind === 'tvar' && a.captured && this.containsType(t.args[i], a.wildcard)) continue;
            return false;
          }
        }
        if (t.outer && t.outer.kind === 'class' && t.outer.args.length && sup.outer && sup.outer.kind === 'class') {
          return this.isSubtype(sup.outer, t.outer, unchecked);
        }
        return true;
      }
      default: return false;
    }
  }

  isSubtypeUnchecked(s, t) {
    if (this.isSubtype(s, t, true)) return true;
    // unchecked conversion: raw S to parameterized T
    if (s.kind === 'class' && t.kind === 'class') {
      const sup = this.asSuper(s, t.sym);
      if (sup && (sup.args.length === 0 || this.isRaw(s))) return true;
    }
    if (s.kind === 'array' && t.kind === 'array' && s.elem.kind !== 'prim' && t.elem.kind !== 'prim') return this.isSubtypeUnchecked(s.elem, t.elem);
    return false;
  }

  // ---- boxing ------------------------------------------------------------
  boxedClass(prim) {
    return this.syms.typeOf(BOX_NAMES[prim.tag]);
  }

  unboxedType(t) {
    if (!t) return null;
    if (t.kind === 'class') {
      const p = UNBOX[t.sym.fullName];
      return p ? PRIM[p] : null;
    }
    if (t.kind === 'tvar' || t.kind === 'intersection') {
      // T extends Integer
      const bounds = t.kind === 'tvar' ? (t.bounds || []) : t.bounds;
      for (const b of bounds) {
        const u = this.unboxedType(b);
        if (u) return u;
      }
    }
    return null;
  }

  // primitive type after unboxing if necessary, else null
  unboxedTypeOrSelf(t) {
    if (t.kind === 'prim') return t;
    return this.unboxedType(t);
  }

  // ---- assignment and method invocation conversions -------------------
  // strict invocation: identity, widening primitive, widening reference
  isConvertibleStrict(s, t) {
    if (s.kind === 'prim' !== (t.kind === 'prim')) return false;
    return this.isSubtypeUnchecked(s, t);
  }

  // loose invocation: also boxing / unboxing
  isConvertible(s, t) {
    if (!s || !t) return false;
    if (s.kind === 'unknown' || t.kind === 'unknown') return true;
    const sp = s.kind === 'prim';
    const tp = t.kind === 'prim';
    if (sp === tp) return this.isSubtypeUnchecked(s, t);
    if (sp) {
      if (s.tag === 'void') return false;
      return this.isSubtype(this.boxedClass(s), t, true);
    }
    // unboxing then widening
    const u = this.unboxedType(s);
    return !!u && this.isSubtype(u, t);
  }

  // assignment context, including narrowing of constants (handled by caller with constant value)
  isAssignable(s, t, constValue) {
    if (s.kind === 'prim' && t.kind === 'prim' && constValue !== undefined && constValue !== null && s.tag === 'int') {
      if (t.tag === 'byte' && constValue >= -128 && constValue <= 127) return true;
      if (t.tag === 'short' && constValue >= -32768 && constValue <= 32767) return true;
      if (t.tag === 'char' && constValue >= 0 && constValue <= 65535) return true;
    }
    if (s.kind === 'prim' && (s.tag === 'int' || s.tag === 'short' || s.tag === 'char' || s.tag === 'byte') && t.kind === 'class' && constValue !== undefined && constValue !== null) {
      const u = this.unboxedType(t);
      if (u && (u.tag === 'byte' || u.tag === 'short' || u.tag === 'char') && this.isAssignable(s, u, constValue)) return true;
    }
    return this.isConvertible(s, t);
  }

  // casting context (lenient: valid programs only)
  isCastable(s, t) {
    if (s.kind === 'prim' && t.kind === 'prim') {
      if (s.tag === 'boolean' || t.tag === 'boolean') return s.tag === t.tag;
      return true;
    }
    return true;
  }

  // ---- numeric promotion ---------------------------------------------
  unaryPromotion(t) {
    const p = this.unboxedTypeOrSelf(t);
    if (!p) return null;
    if (p.tag === 'byte' || p.tag === 'short' || p.tag === 'char') return PRIM.int;
    return p;
  }

  binaryPromotion(a, b) {
    const pa = this.unboxedTypeOrSelf(a);
    const pb = this.unboxedTypeOrSelf(b);
    if (!pa || !pb) return null;
    if (pa.tag === 'double' || pb.tag === 'double') return PRIM.double;
    if (pa.tag === 'float' || pb.tag === 'float') return PRIM.float;
    if (pa.tag === 'long' || pb.tag === 'long') return PRIM.long;
    return PRIM.int;
  }

  // ---- lub (approximation of JLS 4.10.4) -----------------------------
  lub(types) {
    const ts = types.filter((t) => t && t.kind !== 'null');
    if (ts.length === 0) return types.length ? NULL : this.objectType;
    if (ts.length === 1) return ts[0];
    // if one is supertype of all others, take it
    for (const c of ts) {
      if (ts.every((t) => this.isSubtype(t, c))) return c;
    }
    if (ts.every((t) => t.kind === 'array')) {
      const elems = ts.map((t) => t.elem);
      if (elems.every((e) => e.kind !== 'prim')) return new ArrayType(this.lub(elems));
      return this.objectType;
    }
    // erased candidate set: supertypes common to all
    const erasedSupers = (t) => {
      const out = [];
      const seen = new Set();
      const go = (u) => {
        if (!u) return;
        if (u.kind === 'tvar' || u.kind === 'intersection') {
          for (const b of (u.kind === 'tvar' ? (u.bounds || [this.objectType]) : u.bounds)) go(b);
          return;
        }
        if (u.kind === 'array') { go(this.objectType); go(this.syms.typeOf('java.lang.Cloneable')); go(this.syms.typeOf('java.io.Serializable')); return; }
        if (u.kind !== 'class') return;
        if (seen.has(u.sym)) return;
        seen.add(u.sym);
        out.push(u.sym);
        go(this.supertype(u));
        for (const i of this.interfaces(u)) go(i);
      };
      go(t);
      return out;
    };
    let common = erasedSupers(ts[0]);
    for (let k = 1; k < ts.length; k++) {
      const s = new Set(erasedSupers(ts[k]));
      common = common.filter((c) => s.has(c));
    }
    // minimal elements
    const minimal = common.filter((c) => !common.some((d) => d !== c && this.syms.isSubClass(d, c)));
    const pick = minimal.filter((c) => c !== this.syms.objectSym);
    const candidates = pick.length ? pick : [this.syms.objectSym];
    const parameterize = (sym) => {
      // choose parameterization: if all agree use it, otherwise wildcard ? extends lub (shallow)
      const insts = ts.map((t) => this.asSuper(t, sym));
      if (insts.some((i) => !i || i.args.length === 0)) return this.syms.erasedType(sym);
      const n = insts[0].args.length;
      const args = [];
      for (let i = 0; i < n; i++) {
        const ai = insts.map((x) => x.args[i]);
        if (ai.every((a) => this.isSameTypeArg(a, ai[0]))) args.push(ai[0]);
        else args.push(new WildcardType('extends', this.objectType));
      }
      return new ClassType(sym, args, null);
    };
    if (candidates.length === 1) return parameterize(candidates[0]);
    // prefer a class over interfaces first in intersection
    candidates.sort((x, y) => (x.isInterface() ? 1 : 0) - (y.isInterface() ? 1 : 0));
    return new IntersectionType(candidates.map(parameterize));
  }

  // greatest lower bound for intersections of bounds (simple)
  glb(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (this.isSubtype(a, b)) return a;
    if (this.isSubtype(b, a)) return b;
    return new IntersectionType([a, b]);
  }

  // ---- capture conversion (JLS 5.1.10) -----------------------------------
  capture(t) {
    if (!t || t.kind !== 'class' || !t.args.some((a) => a.kind === 'wildcard')) {
      if (t && t.kind === 'class' && t.outer && t.outer.kind === 'class' && t.outer.args.some((a) => a.kind === 'wildcard')) {
        return new ClassType(t.sym, t.args, this.capture(t.outer));
      }
      return t;
    }
    const sym = this.syms.completeHeader(t.sym);
    const formals = sym.typarams || [];
    if (formals.length !== t.args.length) return t;
    const newArgs = t.args.map((a, i) => (a.kind === 'wildcard' ? new CapturedTypeVar(a, formals[i]) : a));
    for (let i = 0; i < newArgs.length; i++) {
      const a = newArgs[i];
      if (!(a instanceof CapturedTypeVar)) continue;
      const w = a.wildcard;
      const declared = (formals[i].bounds || [this.objectType]).map((b) => this.subst(b, formals, newArgs));
      if (w.bk === 'extends') {
        const ub = w.bound;
        const bounds = [ub];
        for (const d of declared) if (!this.isObject(d) && !this.isSubtype(ub, d)) bounds.push(d);
        a.bounds = bounds;
      } else {
        a.bounds = declared.length ? declared : [this.objectType];
        if (w.bk === 'super') a.lower = w.bound;
      }
    }
    return new ClassType(t.sym, newArgs, t.outer);
  }

  // upward projection of captured vars, used when a captured type escapes into an inferred local type
  upward(t) {
    if (!t) return t;
    if (t.kind === 'tvar' && t.captured) return this.upward(t.upperBound() || this.objectType);
    if (t.kind === 'class' && t.args.length) {
      let changed = false;
      const args = t.args.map((a) => {
        if (a.kind === 'tvar' && a.captured) {
          changed = true;
          const w = a.wildcard;
          return w;
        }
        return a;
      });
      return changed ? new ClassType(t.sym, args, t.outer) : t;
    }
    if (t.kind === 'array') {
      const e = this.upward(t.elem);
      return e === t.elem ? t : new ArrayType(e);
    }
    return t;
  }

  // ---- member types --------------------------------------------------------
  // The type of member sym (field or method) as seen from site.
  memberType(site, sym) {
    const owner = sym.owner;
    const st = sym.type;
    if (!site || site.kind !== 'class' && site.kind !== 'tvar' && site.kind !== 'intersection' && site.kind !== 'array') return st;
    if (sym.flags & 0x0008 && !(owner.typarams && owner.typarams.length)) return st;
    let base = site;
    if (site.kind === 'tvar' || site.kind === 'intersection') {
      base = this.asSuper(site, owner) || site;
    }
    const sup = base.kind === 'class' ? (base.sym === owner ? base : this.asSuper(base, owner) || this.asOuterSuper(base, owner)) : null;
    if (!sup) return st;
    if (this.isRaw(sup)) {
      return this.erasure(st);
    }
    let r = st;
    let o = sup;
    let os = owner;
    while (o && o.kind === 'class' && os) {
      const tps = os.typarams || [];
      if (tps.length && o.args.length === tps.length) r = this.subst(r, tps, o.args);
      if (os.flags & 0x0008) break;
      o = o.outer;
      os = os.outerClassForTypeParams();
    }
    return r;
  }

  // element type of an array, or null
  elemtype(t) {
    if (!t) return null;
    if (t.kind === 'array') return t.elem;
    if (t.kind === 'tvar' && t.bounds) {
      for (const b of t.bounds) { const e = this.elemtype(b); if (e) return e; }
    }
    return null;
  }

  dimensions(t) {
    let n = 0;
    while (t.kind === 'array') { n++; t = t.elem; }
    return n;
  }

  // ---- descriptors and signatures ----------------------------------------
  descriptor(t) {
    const e = this.erasure(t);
    switch (e.kind) {
      case 'prim': return DESC[e.tag];
      case 'class': return `L${e.sym.binaryName()};`;
      case 'array': return `[${this.descriptor(e.elem)}`;
      case 'method': return `(${e.params.map((p) => this.descriptor(p)).join('')})${this.descriptor(e.ret)}`;
      case 'null': return 'Ljava/lang/Object;';
      default: return 'Ljava/lang/Object;';
    }
  }

  signature(t) {
    switch (t.kind) {
      case 'prim': return DESC[t.tag];
      case 'class': {
        if (t.outer && t.outer.kind === 'class' && this.isParameterizedOuter(t.outer) && !(t.sym.flags & 0x0008)) {
          const outerSig = this.signature(t.outer);
          return `${outerSig.slice(0, -1)}.${t.sym.name}${this.typeArgsSig(t.args)};`;
        }
        return `L${t.sym.binaryName()}${this.typeArgsSig(t.args)};`;
      }
      case 'array': return `[${this.signature(t.elem)}`;
      case 'tvar': return t.captured ? this.signature(this.erasure(t)) : `T${t.name};`;
      case 'intersection': return this.signature(t.bounds[0]);
      case 'method': {
        const tp = t.typarams.length ? this.typeParamsSig(t.typarams) : '';
        const thrown = t.thrown.some((x) => x.kind === 'tvar') ? t.thrown.map((x) => `^${this.signature(x)}`).join('') : '';
        return `${tp}(${t.params.map((p) => this.signature(p)).join('')})${this.signature(t.ret)}${thrown}`;
      }
      default: return 'Ljava/lang/Object;';
    }
  }

  typeArgsSig(args) {
    if (!args.length) return '';
    return `<${args.map((a) => {
      if (a.kind === 'wildcard') {
        if (a.bk === 'unbound') return '*';
        return (a.bk === 'extends' ? '+' : '-') + this.signature(a.bound);
      }
      return this.signature(a);
    }).join('')}>`;
  }

  typeParamsSig(tvars) {
    return `<${tvars.map((tv) => {
      const bounds = tv.bounds && tv.bounds.length ? tv.bounds : [this.objectType];
      let s = tv.name;
      bounds.forEach((b, i) => {
        const e = b.kind === 'class' ? this.syms.completeHeader(b.sym) : null;
        // class bound slot is empty when the first bound is an interface
        if (i === 0 && e && e.isInterface()) s += ':';
        s += `:${this.signature(b)}`;
      });
      return s;
    }).join('')}>`;
  }

  // does the type need a Signature attribute?
  needsSignature(t) {
    switch (t.kind) {
      case 'class': return t.args.length > 0 || (t.outer && t.outer.kind === 'class' && this.needsSignature(t.outer) && !(t.sym.flags & 0x0008));
      case 'array': return this.needsSignature(t.elem);
      case 'tvar': return !t.captured;
      case 'method': return t.typarams.length > 0 || t.params.some((p) => this.needsSignature(p)) || this.needsSignature(t.ret) || t.thrown.some((x) => x.kind === 'tvar');
      default: return false;
    }
  }

  // JVM computational category helpers
  isWide(t) { return t.kind === 'prim' && (t.tag === 'long' || t.tag === 'double'); }
}

module.exports = {
  Type, PrimType, ClassType, ArrayType, TypeVar, CapturedTypeVar, WildcardType, IntersectionType, UnionType,
  MethodType, NullType, UnknownType, PackageType, Types, PRIM, NULL, UNKNOWN, BOX_NAMES, UNBOX, DESC,
  isNumericTag, isIntegralTag, typeToString,
};
