'use strict';

// JNI header files (javac -h), following javac's JNIWriter: one header per
// class that declares native methods or @Native fields, with #defines for the
// constant static final fields of the class and its superclasses.

const fs = require('fs');
const path = require('path');
const { F } = require('./flags');

function isalnum(c) {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
}

function encodeChar(c) {
  return `_${c.toString(16).padStart(5, '0')}`;
}

// JNIWriter.encode
function encode(name, mode) {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    const c = name.charCodeAt(i);
    if (isalnum(c)) { out += ch; continue; }
    switch (mode) {
      case 'CLASS':
        out += ch === '.' || ch === '_' ? '_' : ch === '$' ? '__' : encodeChar(c);
        break;
      case 'JNI':
        out += ch === '/' || ch === '.' ? '_' : ch === '_' ? '_1' : ch === ';' ? '_2' : ch === '[' ? '_3' : encodeChar(c);
        break;
      case 'FIELDSTUB':
        out += ch === '_' ? ch : encodeChar(c);
        break;
      default:
        out += encodeChar(c);
    }
  }
  return out;
}

// Double.toString / Float.toString: shortest digits (at least two) that round-trip, in
// Java's layout (plain for 1e-3 <= |v| < 1e7, else d.dddE[-]n)
function javaFloatingToString(v, isFloat) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  let digits;
  let exp; // value = 0.d1d2... * 10^exp  -> we use sci: d1.d2... * 10^exp
  const sci = (s) => {
    const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
    return { neg: m[1] === '-', digits: (m[2] + (m[3] || '')).replace(/0+$/, '') || '0', exp: Number(m[4]) };
  };
  let r;
  if (isFloat) {
    for (let p = 1; p <= 9; p++) {
      const s = v.toExponential(p - 1);
      if (Math.fround(Number(s)) === v) { r = sci(s); break; }
    }
  } else {
    r = sci(v.toExponential());
  }
  // Java picks the closest two-digit decimal when one digit would do
  if (r.digits.length === 1) r = sci(v.toExponential(1));
  digits = r.digits;
  exp = r.exp;
  const sign = r.neg ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e-3 && a < 1e7) {
    let intPart, frac;
    if (exp >= 0) {
      const d = digits.padEnd(exp + 1, '0');
      intPart = d.slice(0, exp + 1);
      frac = d.slice(exp + 1);
    } else {
      intPart = '0';
      frac = '0'.repeat(-exp - 1) + digits;
    }
    return `${sign}${intPart}.${frac || '0'}`;
  }
  return `${sign}${digits[0]}.${digits.slice(1) || '0'}E${exp}`;
}

class JNIWriter {
  constructor(compiler) {
    this.compiler = compiler;
    this.types = compiler.types;
    this.syms = compiler.syms;
  }

  static isNative(m) { return m.kind === 'method' && (m.flags & F.NATIVE) !== 0; }

  hasNativeAnnotation(d) {
    const anns = (d.mods && d.mods.annotations) || [];
    return anns.some((a) => {
      let t = a.annotationType || a.type || a.name;
      const parts = [];
      while (t && t.tag === 'Select') { parts.unshift(t.name); t = t.selected; }
      if (t && t.tag === 'Ident') parts.unshift(t.name);
      const n = parts.join('.');
      return n === 'Native' || n === 'java.lang.annotation.Native';
    });
  }

  // declared members in source order
  members(c) {
    return (c.tree && c.tree.defs) || [];
  }

  needsHeader(c) {
    if (c.isLocal || c.isAnonymous || (c.flags & F.SYNTHETIC)) return false;
    for (const d of this.members(c)) {
      if (d.tag === 'MethodDecl' && d.sym && JNIWriter.isNative(d.sym)) return true;
      if (d.tag === 'VarDecl' && this.hasNativeAnnotation(d)) return true;
    }
    return false;
  }

  isThrowable(t) {
    return this.types.isSubtype(t, this.syms.typeOf('java.lang.Throwable'));
  }

  jniType(t) {
    switch (t.kind) {
      case 'array': {
        const ct = t.elem;
        if (ct.kind === 'prim') return `j${ct.tag}Array`;
        return 'jobjectArray';
      }
      case 'prim': return t.tag === 'void' ? 'void' : `j${t.tag}`;
      case 'class': {
        const n = t.sym.fullName;
        if (n === 'java.lang.String') return 'jstring';
        if (this.isThrowable(t)) return 'jthrowable';
        if (n === 'java.lang.Class') return 'jclass';
        return 'jobject';
      }
      default: throw new Error(`jni unknown type ${t.kind}`);
    }
  }

  // JVM signature; useFlatname selects Outer$Inner over Outer.Inner
  jvmSig(t, useFlatname) {
    const e = this.types.erasure(t);
    switch (e.kind) {
      case 'prim': return this.types.descriptor(e);
      case 'array': return `[${this.jvmSig(e.elem, useFlatname)}`;
      case 'class': return `L${(useFlatname ? e.sym.flatName : e.sym.fullName).replace(/\./g, '/')};`;
      default: throw new Error(`jni signature of ${e.kind}`);
    }
  }

  constDefine(cname, f) {
    const v = this.compiler.attr.constValueOf(f);
    if (v === null || v === undefined) return null;
    const t = f.type;
    if (t.kind !== 'prim') return null;
    let s;
    switch (t.tag) {
      case 'boolean': s = v ? '1L' : '0L'; break;
      case 'byte': case 'short': case 'int': s = `${Number(v)}L`; break;
      case 'long': s = `${BigInt(v)}LL`; break;
      case 'char': s = `${typeof v === 'string' ? v.charCodeAt(0) : Number(v) & 0xffff}L`; break;
      case 'float': {
        const fv = Number(v);
        s = Number.isFinite(fv) || Number.isNaN(fv) ? `${javaFloatingToString(fv, true)}f` : `${fv < 0 ? '-' : ''}Inff`;
        break;
      }
      case 'double': {
        const dv = Number(v);
        s = Number.isFinite(dv) || Number.isNaN(dv) ? javaFloatingToString(dv, false) : `${dv < 0 ? '-' : ''}InfD`;
        break;
      }
      default: return null;
    }
    const fname = encode(f.name, 'FIELDSTUB');
    return [`#undef ${cname}_${fname}`, `#define ${cname}_${fname} ${s}`];
  }

  text(c, nl) {
    const cname = encode(c.fullName, 'CLASS');
    const L = [];
    L.push('/* DO NOT EDIT THIS FILE - it is machine generated */');
    L.push('#include <jni.h>');
    L.push(`/* Header for class ${cname} */`);
    L.push('');
    L.push(`#ifndef _Included_${cname}`);
    L.push(`#define _Included_${cname}`);
    L.push('#ifdef __cplusplus', 'extern "C" {', '#endif');
    const chain = [];
    for (let cd = c; cd; cd = cd.superclass ? this.types.erasure(cd.superclass).sym : null) {
      this.syms.completeHeader(cd);
      chain.push(cd);
    }
    chain.reverse();
    for (const cd of chain) {
      for (const d of this.members(cd)) {
        if (d.tag !== 'VarDecl' || !d.sym) continue;
        const f = d.sym;
        if (!(f.flags & F.FINAL) || !(f.flags & F.STATIC)) continue;
        const def = this.constDefine(cname, f);
        if (def) L.push(...def);
      }
    }
    const natives = this.members(c).filter((d) => d.tag === 'MethodDecl' && d.sym && JNIWriter.isNative(d.sym)).map((d) => d.sym);
    for (const m of natives) {
      const overloaded = natives.some((m2) => m2 !== m && m2.name === m.name);
      const mt = m.type;
      const sig = `(${mt.params.map((p) => this.jvmSig(p, false)).join('')})${this.jvmSig(mt.ret, false)}`;
      let fn = `Java_${encode(c.flatName, 'JNI')}_${encode(m.name, 'JNI')}`;
      if (overloaded) fn += `__${encode(mt.params.map((p) => this.jvmSig(p, true)).join(''), 'JNI')}`;
      L.push('/*');
      L.push(` * Class:     ${cname}`);
      L.push(` * Method:    ${encode(m.name, 'FIELDSTUB')}`);
      L.push(` * Signature: ${sig}`);
      L.push(' */');
      L.push(`JNIEXPORT ${this.jniType(this.types.erasure(mt.ret))} JNICALL ${fn}`);
      const args = [m.flags & F.STATIC ? 'jclass' : 'jobject', ...mt.params.map((p) => this.jniType(this.types.erasure(p)))];
      L.push(`  (JNIEnv *, ${args.join(', ')});`);
      L.push('');
    }
    L.push('#ifdef __cplusplus', '}', '#endif');
    L.push('#endif');
    return L.map((l) => l + nl).join('');
  }

  write(c, dir, nl) {
    const file = path.join(dir, `${c.flatName.replace(/[.$]/g, '_')}.h`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, this.text(c, nl));
    return file;
  }
}

module.exports = { JNIWriter, encode, javaFloatingToString };
