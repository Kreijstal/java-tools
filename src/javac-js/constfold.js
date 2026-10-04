'use strict';

// Compile-time constant evaluation (JLS 15.29) with Java semantics.
// Representation: int/short/byte/char -> JS number (int32 range, char 0..65535),
// long -> BigInt, float -> number already rounded with Math.fround,
// double -> number, boolean -> boolean, String -> string.

const MIN_LONG = -(1n << 63n);

function toInt(v) { return v | 0; }
function toLong(v) {
  if (typeof v === 'bigint') return BigInt.asIntN(64, v);
  return BigInt.asIntN(64, BigInt(v));
}

// Java (int) conversion from float/double (JLS 5.1.3)
function d2i(d) {
  if (Number.isNaN(d)) return 0;
  if (d >= 2147483647) return 2147483647;
  if (d <= -2147483648) return -2147483648;
  return Math.trunc(d) | 0;
}

function d2l(d) {
  if (Number.isNaN(d)) return 0n;
  if (d >= 9223372036854775807) return 9223372036854775807n;
  if (d <= -9223372036854775808) return MIN_LONG;
  return BigInt(Math.trunc(d));
}

function l2d(l) { return Number(l); }
function l2f(l) {
  // correctly rounded long -> float: round to double first can double-round; handle via exact path
  const neg = l < 0n;
  let a = neg ? -l : l;
  if (a < (1n << 53n)) return Math.fround((neg ? -1 : 1) * Number(a));
  // keep 25 significant bits plus sticky
  const bits = a.toString(2).length;
  const shift = BigInt(bits - 25);
  let top = a >> shift;
  const sticky = (a & ((1n << shift) - 1n)) !== 0n ? 1n : 0n;
  top = (top << 1n) | sticky; // 26 bits
  const v = Number(top) * Math.pow(2, Number(shift) - 1);
  return Math.fround((neg ? -1 : 1) * v);
}

function i2c(v) { return v & 0xffff; }
function i2s(v) { return (v << 16) >> 16; }
function i2b(v) { return (v << 24) >> 24; }

// convert constant value of type `from` to primitive type `to`
function convert(v, from, to) {
  if (from === to) return v;
  if (to === 'String') return v;
  if (from === 'boolean' || to === 'boolean') return v;
  let n; // numeric view
  switch (from) {
    case 'long': {
      switch (to) {
        case 'int': return Number(BigInt.asIntN(32, v));
        case 'short': return i2s(Number(BigInt.asIntN(32, v)));
        case 'byte': return i2b(Number(BigInt.asIntN(32, v)));
        case 'char': return i2c(Number(BigInt.asIntN(32, v)));
        case 'float': return l2f(v);
        case 'double': return l2d(v);
        default: return v;
      }
    }
    case 'float': case 'double': {
      n = v;
      switch (to) {
        case 'int': return d2i(n);
        case 'long': return d2l(n);
        case 'short': return i2s(d2i(n));
        case 'byte': return i2b(d2i(n));
        case 'char': return i2c(d2i(n));
        case 'float': return Math.fround(n);
        case 'double': return n;
        default: return v;
      }
    }
    default: { // int-like
      n = v;
      switch (to) {
        case 'int': return n | 0;
        case 'long': return BigInt(n);
        case 'short': return i2s(n);
        case 'byte': return i2b(n);
        case 'char': return i2c(n);
        case 'float': return Math.fround(n);
        case 'double': return n;
        default: return v;
      }
    }
  }
}

// ---- Java Double.toString / Float.toString --------------------------------
// Java prints the shortest decimal that uniquely distinguishes the value
// (since JDK 19, Raffaello Giulietti's algorithm), in plain notation for
// 1e-3 <= |v| < 1e7 and computerized scientific notation otherwise.
function shortestDigits(v, isFloat) {
  // returns {digits: string without dot, exp: decimal exponent e such that v = 0.d1d2... * 10^e}
  let s;
  if (!isFloat) {
    s = v.toExponential(); // shortest round-trip in JS (ES spec uses shortest)
    // toExponential() without argument gives as many digits as necessary to uniquely specify
  } else {
    let p;
    for (p = 1; p <= 9; p++) {
      const t = Number(v.toPrecision(p));
      if (Math.fround(t) === v) break;
    }
    s = v.toExponential(p - 1);
    // Java picks among equally short candidates the one closest to the exact value;
    // toPrecision already rounds correctly from the double value of the float.
  }
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  const digits = (m[2] + (m[3] || '')).replace(/0+$/, '') || '0';
  const exp = parseInt(m[4], 10) + 1;
  return { digits, exp };
}

function javaFloatingToString(v, isFloat) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  const neg = v < 0;
  const a = Math.abs(v);
  const { digits, exp } = shortestDigits(a, isFloat);
  let out;
  if (a >= 1e-3 && a < 1e7) {
    if (exp <= 0) {
      out = '0.' + '0'.repeat(-exp) + digits;
    } else if (digits.length <= exp) {
      out = digits + '0'.repeat(exp - digits.length) + '.0';
    } else {
      out = digits.slice(0, exp) + '.' + digits.slice(exp);
    }
  } else {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : `${digits[0]}.0`;
    out = `${mant}E${exp - 1}`;
  }
  return (neg ? '-' : '') + out;
}

// String conversion of a constant of primitive type `tag`
function constToString(v, tag) {
  switch (tag) {
    case 'String': return v;
    case 'boolean': return v ? 'true' : 'false';
    case 'char': return String.fromCharCode(v);
    case 'long': return v.toString();
    case 'float': return javaFloatingToString(v, true);
    case 'double': return javaFloatingToString(v, false);
    default: return String(v);
  }
}

// binary op on constants already promoted to `tag` (int/long/float/double/boolean/String)
function binary(op, a, b, tag) {
  if (tag === 'String') {
    if (op === '+') return a + b;
    return undefined;
  }
  if (tag === 'boolean') {
    switch (op) {
      case '&&': case '&': return a && b;
      case '||': case '|': return a || b;
      case '^': return a !== b;
      case '==': return a === b;
      case '!=': return a !== b;
      default: return undefined;
    }
  }
  if (tag === 'int') {
    switch (op) {
      case '+': return (a + b) | 0;
      case '-': return (a - b) | 0;
      case '*': return Math.imul(a, b);
      case '/': if (b === 0) return undefined; if (a === -2147483648 && b === -1) return a; return (a / b) | 0;
      case '%': if (b === 0) return undefined; if (b === -1) return 0; return a % b | 0;
      case '&': return a & b;
      case '|': return a | b;
      case '^': return a ^ b;
      case '<<': return a << (b & 31);
      case '>>': return a >> (b & 31);
      case '>>>': return (a >>> (b & 31)) | 0;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      case '==': return a === b;
      case '!=': return a !== b;
      default: return undefined;
    }
  }
  if (tag === 'long') {
    switch (op) {
      case '+': return BigInt.asIntN(64, a + b);
      case '-': return BigInt.asIntN(64, a - b);
      case '*': return BigInt.asIntN(64, a * b);
      case '/': if (b === 0n) return undefined; return BigInt.asIntN(64, a / b);
      case '%': if (b === 0n) return undefined; return BigInt.asIntN(64, a % b);
      case '&': return BigInt.asIntN(64, a & b);
      case '|': return BigInt.asIntN(64, a | b);
      case '^': return BigInt.asIntN(64, a ^ b);
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      case '==': return a === b;
      case '!=': return a !== b;
      default: return undefined;
    }
  }
  // float / double
  const r = (x) => (tag === 'float' ? Math.fround(x) : x);
  switch (op) {
    case '+': return r(a + b);
    case '-': return r(a - b);
    case '*': return r(a * b);
    case '/': return r(a / b);
    case '%': return r(javaFmod(a, b));
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    case '==': return a === b;
    case '!=': return a !== b;
    default: return undefined;
  }
}

function javaFmod(a, b) {
  return a % b; // JS % on numbers matches Java's fmod semantics (truncating, sign of dividend)
}

// shift with long left operand and int/long right operand
function shiftLong(op, a, b) {
  const n = BigInt(Number(typeof b === 'bigint' ? b & 63n : b & 63));
  switch (op) {
    case '<<': return BigInt.asIntN(64, a << n);
    case '>>': return BigInt.asIntN(64, a >> n);
    case '>>>': return BigInt.asIntN(64, BigInt.asUintN(64, a) >> n);
    default: return undefined;
  }
}

function unary(op, v, tag) {
  switch (op) {
    case 'pos': return v;
    case 'neg':
      if (tag === 'int') return (-v) | 0;
      if (tag === 'long') return BigInt.asIntN(64, -v);
      if (tag === 'float') return Math.fround(-v);
      return -v;
    case 'compl':
      if (tag === 'int') return ~v;
      if (tag === 'long') return BigInt.asIntN(64, ~v);
      return undefined;
    case 'not': return !v;
    default: return undefined;
  }
}

module.exports = { convert, binary, unary, shiftLong, constToString, javaFloatingToString, toInt, toLong };
