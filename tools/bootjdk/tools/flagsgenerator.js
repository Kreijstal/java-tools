'use strict';
// Port of the langtools build tool flagsgenerator.FlagsGenerator: reads the
// @Use/@CustomToStringValue/@NoToStringValue annotated constants of
// com/sun/tools/javac/code/Flags.java and writes FlagsEnum.java. The real tool
// attributes Flags.java with javac; here the class body's field declarations
// are parsed and their constant initializers evaluated directly.

const fs = require('fs');
const { LNSEP } = require('./util');

function tokenize(src) {
  const toks = [];
  const re = /\s+|\/\/[^\n\r]*|\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)[lL]?|[A-Za-z_$][\w$]*|>>>=|<<=|>>=|>>>|<<|>>|[-+*\/%&|^!~=<>?:;,.(){}\[\]@]/y;
  let m;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    if (!(m = re.exec(src))) throw new Error('FlagsGenerator: cannot tokenize at ' + at);
    const t = m[0];
    if (/^\s/.test(t) || t.startsWith('//') || t.startsWith('/*')) continue;
    toks.push(t);
  }
  return toks;
}

function javaStringLiteral(t) {
  const body = t.slice(1, -1);
  return body.replace(/\\(u+[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (_, e) => {
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(-4), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', s: ' ' }[e] ?? e;
  });
}

// fields declared directly in the top-level class, with their annotations
function collectFields(toks) {
  let i = 0;
  while (i < toks.length && !(toks[i] === 'class' || toks[i] === 'interface' || toks[i] === 'enum')) i++;
  while (toks[i] !== '{') i++;
  i++;
  const fields = [];
  const skipBalanced = (open, close) => {
    let d = 0;
    do {
      if (toks[i] === open) d++;
      else if (toks[i] === close) d--;
      i++;
    } while (d > 0);
  };
  while (i < toks.length && toks[i] !== '}') {
    // one member
    const annos = [];
    const head = [];
    while (true) {
      const t = toks[i];
      if (t === '@' && toks[i + 1] !== 'interface') {
        i++;
        let name = toks[i++];
        while (toks[i] === '.') { name += '.' + toks[i + 1]; i += 2; }
        let argToks = null;
        if (toks[i] === '(') { const s = i; skipBalanced('(', ')'); argToks = toks.slice(s + 1, i - 1); }
        annos.push({ name, argToks });
      } else if (t === ';') { i++; break; }
      else if (t === '{') { skipBalanced('{', '}'); break; }
      else if (t === '(' && head.length && head[head.length - 1] !== '=') {
        // method/constructor: skip parameter list and body
        skipBalanced('(', ')');
        while (toks[i] !== '{' && toks[i] !== ';') i++;
        if (toks[i] === '{') skipBalanced('{', '}'); else i++;
        head.length = 0;
        break;
      } else if (t === '=') {
        // field declarators: NAME = expr (, NAME = expr)* ;
        let name = head[head.length - 1];
        i++;
        for (;;) {
          const s = i;
          let d = 0;
          while (!(d === 0 && (toks[i] === ',' || toks[i] === ';'))) {
            if (toks[i] === '(' || toks[i] === '{' || toks[i] === '[') d++;
            else if (toks[i] === ')' || toks[i] === '}' || toks[i] === ']') d--;
            i++;
          }
          fields.push({ name, annos, mods: head.slice(0, -1), init: toks.slice(s, i) });
          if (toks[i++] === ';') break;
          name = toks[i];
          i += 2;
        }
        head.length = 0;
        break;
      } else { head.push(t); i++; }
    }
  }
  return fields;
}

const M64 = (1n << 64n) - 1n;
const wrap = (v, type) => (type === 'long' ? BigInt.asIntN(64, v) : BigInt.asIntN(32, v));

// constant expression evaluator: values are {v: BigInt, t: 'int'|'long'}
function makeEvaluator(fieldMap) {
  const cache = new Map();
  function valueOf(name) {
    if (cache.has(name)) return cache.get(name);
    const f = fieldMap.get(name);
    if (!f) throw new Error('FlagsGenerator: unknown constant ' + name);
    const declType = f.mods[f.mods.length - 1];
    let r = evalToks(f.init);
    if (declType === 'long' && r.t === 'int') r = { v: r.v, t: 'long' };
    cache.set(name, r);
    return r;
  }
  function evalToks(toks) {
    let p = 0;
    const peek = () => toks[p];
    const bin = (a, b) => (a.t === 'long' || b.t === 'long' ? 'long' : 'int');
    const prec = { '|': 1, '^': 2, '&': 3, '<<': 5, '>>': 5, '>>>': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7 };
    function unary() {
      const t = toks[p++];
      if (t === '~') { const a = unary(); return { v: wrap(~a.v, a.t), t: a.t }; }
      if (t === '-') { const a = unary(); return { v: wrap(-a.v, a.t), t: a.t }; }
      if (t === '+') return unary();
      if (t === '(') {
        if ((peek() === 'long' || peek() === 'int') && toks[p + 1] === ')') {
          const ty = toks[p]; p += 2;
          const a = unary();
          return { v: wrap(a.v, ty), t: ty };
        }
        const r = expr(0);
        if (toks[p++] !== ')') throw new Error('FlagsGenerator: ) expected');
        return r;
      }
      const lit = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)([lL]?)$/.exec(t);
      if (lit) {
        let s = lit[1].replace(/_/g, '');
        const ty = lit[2] ? 'long' : 'int';
        let v;
        if (/^0[xXbB]/.test(s)) v = BigInt(s);
        else if (s.length > 1 && s[0] === '0') v = BigInt('0o' + s.slice(1));
        else v = BigInt(s);
        return { v: wrap(v, ty), t: ty };
      }
      let name = t;
      while (peek() === '.') { name = toks[p + 1]; p += 2; }
      return valueOf(name);
    }
    function expr(minPrec) {
      let a = unary();
      for (;;) {
        const op = peek();
        const pr = prec[op];
        if (pr === undefined || pr <= minPrec - 1 || pr < minPrec) return a;
        p++;
        const b = expr(pr + 1);
        let t, v;
        if (op === '<<' || op === '>>' || op === '>>>') {
          t = a.t;
          const sh = BigInt(Number(b.v & (t === 'long' ? 63n : 31n)));
          const bits = t === 'long' ? 64n : 32n;
          if (op === '<<') v = a.v << sh;
          else if (op === '>>') v = a.v >> sh;
          else v = (a.v & (t === 'long' ? M64 : 0xffffffffn)) >> sh;
          void bits;
        } else {
          t = bin(a, b);
          switch (op) {
            case '|': v = a.v | b.v; break;
            case '^': v = a.v ^ b.v; break;
            case '&': v = a.v & b.v; break;
            case '+': v = a.v + b.v; break;
            case '-': v = a.v - b.v; break;
            case '*': v = a.v * b.v; break;
            case '/': v = a.v / b.v; break;
            default: v = a.v % b.v;
          }
        }
        a = { v: wrap(v, t), t };
      }
    }
    const r = expr(0);
    if (p !== toks.length) throw new Error('FlagsGenerator: unsupported initializer ' + toks.join(' '));
    return r;
  }
  return valueOf;
}

const TARGETS = ['BLOCK', 'CLASS', 'METHOD', 'MODULE', 'PACKAGE', 'TYPE_VAR', 'VARIABLE'];

// annotation's single value: (value = x) or (x); array or element
function annoValue(argToks) {
  let t = argToks;
  if (t.length >= 2 && t[1] === '=') t = t.slice(2);
  if (t[0] === '{') t = t.slice(1, -1);
  const vals = [];
  let cur = [];
  for (const x of t) {
    if (x === ',') { if (cur.length) vals.push(cur); cur = []; } else cur.push(x);
  }
  if (cur.length) vals.push(cur);
  return vals;
}

function main(args) {
  const src = fs.readFileSync(args[0], 'utf8');
  const fields = collectFields(tokenize(src));
  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const valueOf = makeEvaluator(fieldMap);

  const flag2Names = new Map();
  const target2Bits = new Map();
  const customToString = new Map();
  const noToString = new Set();
  for (const f of fields) {
    for (const a of f.annos) {
      const simple = a.name.slice(a.name.lastIndexOf('.') + 1);
      if (simple === 'Use') {
        const v = BigInt.asUintN(64, valueOf(f.name).v);
        const flagBit = v === 0n ? -1 : v.toString(2).length - 1;
        if (!flag2Names.has(flagBit)) flag2Names.set(flagBit, []);
        flag2Names.get(flagBit).push(f.name);
        for (const vt of annoValue(a.argToks)) {
          const target = vt[vt.length - 1];
          if (!TARGETS.includes(target)) throw new Error('No enum constant FlagTarget.' + target);
          if (!target2Bits.has(target)) target2Bits.set(target, new Map());
          const m = target2Bits.get(target);
          if (!m.has(flagBit)) m.set(flagBit, []);
          m.get(flagBit).push(f.name);
        }
      } else if (simple === 'CustomToStringValue') {
        customToString.set(f.name, javaStringLiteral(annoValue(a.argToks)[0].join('')));
      } else if (simple === 'NoToStringValue') {
        noToString.add(f.name);
      }
    }
  }
  for (const target of TARGETS) {
    const m = target2Bits.get(target);
    if (!m) continue;
    for (const [bit, names] of m) {
      if (names.length > 1) {
        throw new Error('java.lang.AssertionError: duplicate flag for target: ' + target + ', flag: ' + bit
          + ', flags fields: [' + names.join(', ') + ']');
      }
    }
  }

  let out = 'package com.sun.tools.javac.code;\n\npublic enum FlagsEnum {\n' + LNSEP;
  for (const bit of [...flag2Names.keys()].sort((a, b) => a - b)) {
    const names = flag2Names.get(bit);
    const toString = names.filter((n) => !noToString.has(n))
      .map((n) => (customToString.has(n) ? customToString.get(n) : n.toLowerCase())).join(' or ');
    out += '    ' + names.join('_OR_') + '(1L<<' + bit + ', "' + toString + '"),' + LNSEP;
  }
  out += '    ;\n\n'
    + '    private final long value;\n'
    + '    private final String toString;\n'
    + '    private FlagsEnum(long value, String toString) {\n'
    + '        this.value = value;\n'
    + '        this.toString = toString;\n'
    + '    }\n'
    + '    public long value() {\n'
    + '        return value;\n'
    + '    }\n'
    + '    public String toString() {\n'
    + '        return toString;\n'
    + '    }\n'
    + '}\n' + LNSEP;
  fs.writeFileSync(args[1], out, 'utf8');
  return 0;
}

module.exports = { main };
