'use strict';
// Java library behaviour the generatenimbus port depends on:
// Double.toString/Float.toString (shortest repr, JDK 19+) and HashMap
// iteration order for String keys.

// digits/exponent -> Java's Double/Float.toString layout
function layout(neg, digits, exp10) {
  // value = 0.digits * 10^exp10... expressed via sci exponent E
  const E = exp10;
  let s;
  if (E >= -3 && E < 7) {
    if (E >= 0) {
      const ip = digits.slice(0, E + 1).padEnd(E + 1, '0');
      const fp = digits.slice(E + 1) || '0';
      s = ip + '.' + fp;
    } else {
      s = '0.' + '0'.repeat(-E - 1) + digits;
    }
  } else {
    s = digits[0] + '.' + (digits.slice(1) || '0') + 'E' + E;
  }
  return (neg ? '-' : '') + s;
}

function special(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  return null;
}

// "d.ddde+x" -> [digits without trailing zeros, x]
function sci(str) {
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(str);
  const digits = (m[1] + (m[2] || '')).replace(/0+$/, '') || '0';
  return [digits, parseInt(m[3], 10)];
}

function doubleToString(v) {
  const sp = special(v);
  if (sp) return sp;
  // (subnormal doubles where Java prefers a closer 2-digit decimal are not handled)
  const [digits, e] = sci(Math.abs(v).toExponential());
  return layout(v < 0, digits, e);
}

// v must already be a float value (Math.fround)
function floatToString(v) {
  const sp = special(v);
  if (sp) return sp;
  const a = Math.abs(v);
  // exact value of a as m * 2^k
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, a);
  const bits = dv.getBigUint64(0);
  const bexp = Number((bits >> 52n) & 0x7ffn);
  const m = (bits & ((1n << 52n) - 1n)) | (bexp ? 1n << 52n : 0n);
  const k = (bexp ? bexp : 1) - 1075;
  // |mant * 10^q - a|, all candidates scaled alike
  const dist = (mant, q) => {
    const Q = BigInt(Math.max(0, -q)), K = BigInt(Math.max(0, -k));
    const l = mant * 10n ** (BigInt(q) + Q) * 2n ** K;
    const r = m * 2n ** (BigInt(k) + K) * 10n ** Q;
    return l > r ? l - r : r - l;
  };
  const nearest = (p) => {
    const [d0, e0] = sci(a.toExponential(p - 1));
    // the nearest p-digit decimals (ties go to the even digit)
    const base = BigInt(d0.padEnd(p, '0'));
    let best = null;
    for (const delta of [-1n, 0n, 1n]) {
      const mant = base + delta;
      if (mant <= 0n) continue;
      const ms = mant.toString();
      const e = e0 + (ms.length - p);
      const val = Number(ms[0] + '.' + ms.slice(1) + 'e' + e);
      if (Math.fround(val) !== a) continue;
      const d = dist(mant, e - (ms.length - 1));
      if (best === null || d < best.dist || (d === best.dist && mant % 2n === 0n)) {
        best = { dist: d, digits: ms.replace(/0+$/, '') || '0', e };
      }
    }
    return best;
  };
  for (let p = 1; p <= 9; p++) {
    let best = nearest(p);
    if (!best) continue;
    // when one digit suffices Java picks the closest of the 1- and 2-digit decimals
    if (p === 1) { const b2 = nearest(2); if (b2 && b2.dist < best.dist) best = b2; }
    return layout(v < 0, best.digits, best.e);
  }
  return doubleToString(v);
}

function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

function tableSizeFor(c) {
  let n = 1;
  while (n < c) n *= 2;
  return n;
}

// java.util.HashMap<String, V>: tracks capacity so that iteration order
// (bucket index, then insertion order within a bucket) matches Java's
class JHashMap {
  constructor(src) {
    this.map = new Map();
    this.cap = 0;
    this.thr = 0;
    if (src) {
      const s = src.map.size;
      if (s > 0) {
        const t = Math.trunc(Math.fround(Math.fround(s / 0.75) + 1));
        if (t > this.thr) this.thr = tableSizeFor(t);
      }
      for (const [k, v] of src.entries()) this.put(k, v);
    }
  }
  put(k, v) {
    if (this.map.has(k)) { this.map.set(k, v); return; }
    if (this.cap === 0) {
      this.cap = this.thr > 0 ? this.thr : 16;
      this.thr = Math.trunc(this.cap * 0.75);
    }
    this.map.set(k, v);
    if (this.map.size > this.thr) {
      this.thr = this.cap >= 16 ? this.thr * 2 : Math.trunc(this.cap * 2 * 0.75);
      this.cap *= 2;
    }
  }
  get(k) { return this.map.get(k); }
  has(k) { return this.map.has(k); }
  get size() { return this.map.size; }
  entries() {
    const n = this.cap;
    const idx = (k) => { const h = stringHash(k); return (h ^ (h >>> 16)) & (n - 1); };
    const list = [...this.map.entries()].map((e, i) => [idx(e[0]), i, e]);
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return list.map((x) => x[2]);
  }
}

module.exports = { doubleToString, floatToString, stringHash, JHashMap };
