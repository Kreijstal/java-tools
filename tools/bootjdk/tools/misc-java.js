'use strict';
// Java library behaviour shared by the misc build tool ports (FieldGen,
// EquivMapsGenerator, TzdbZoneRulesCompiler, ...): String.hashCode,
// HashMap/HashSet iteration order, String.compareTo, DataOutputStream.

// String.hashCode()
function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// String.compareTo: UTF-16 code unit order
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tableSizeFor(c) {
  let n = 1;
  while (n < c) n *= 2;
  return Math.max(n, 1);
}

// java.util.HashMap with String keys (or keys given an explicit hash
// function), reproducing its iteration order: by bucket index, then by
// insertion order within the bucket (resizes keep that relative order).
// Treeified bins are not modelled.
class JHashMap {
  constructor(initialCapacity, hashFn) {
    this.hashFn = hashFn || stringHash;
    this.initCap = initialCapacity === undefined ? 16 : tableSizeFor(initialCapacity);
    this.cap = 0;
    this.map = new Map(); // key -> { key, value, hash, seq }
    this.seq = 0;
  }
  static spread(h) { return (h ^ (h >>> 16)) | 0; }
  get size() { return this.map.size; }
  has(k) { return this.map.has(k); }
  get(k) { const e = this.map.get(k); return e === undefined ? undefined : e.value; }
  set(k, v) {
    const e = this.map.get(k);
    if (e) { e.value = v; return this; }
    if (this.cap === 0) this.cap = this.initCap;
    this.map.set(k, { key: k, value: v, hash: JHashMap.spread(this.hashFn(k)), seq: this.seq++ });
    if (this.map.size > Math.floor(this.cap * 0.75)) this.cap *= 2;
    return this;
  }
  delete(k) { return this.map.delete(k); }
  clear() { this.map.clear(); }
  entries() {
    const mask = this.cap - 1;
    return [...this.map.values()]
      .sort((a, b) => ((a.hash & mask) - (b.hash & mask)) || (a.seq - b.seq))
      .map(e => [e.key, e.value]);
  }
  keys() { return this.entries().map(e => e[0]); }
  values() { return this.entries().map(e => e[1]); }
}

// HashMap(int) / HashSet(Collection) sizing helper: new HashSet<>(c) uses
// max((int)(c.size()/.75f) + 1, 16)
function collectionCapacity(n) {
  return Math.max(Math.floor(n / 0.75) + 1, 16);
}

class JHashSet {
  constructor(initialCapacity, hashFn) { this.m = new JHashMap(initialCapacity, hashFn); }
  get size() { return this.m.size; }
  has(k) { return this.m.has(k); }
  add(k) { const had = this.m.has(k); if (!had) this.m.set(k, true); return !had; }
  delete(k) { return this.m.delete(k); }
  clear() { this.m.clear(); }
  values() { return this.m.keys(); }
  [Symbol.iterator]() { return this.values()[Symbol.iterator](); }
}

// java.io.DataOutputStream into a growable buffer
class DataOutput {
  constructor() { this.buf = Buffer.alloc(1024); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    const nb = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(nb, 0, 0, this.len);
    this.buf = nb;
  }
  writeByte(v) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
  write(bytes) { this.ensure(bytes.length); for (const b of bytes) this.buf[this.len++] = b & 0xff; }
  writeBoolean(v) { this.writeByte(v ? 1 : 0); }
  writeShort(v) { this.writeByte(v >> 8); this.writeByte(v); }
  writeChar(v) { this.writeShort(v); }
  writeInt(v) { this.ensure(4); this.buf.writeInt32BE(v | 0, this.len); this.len += 4; }
  writeLong(v) { this.ensure(8); this.buf.writeBigInt64BE(BigInt.asIntN(64, BigInt(v)), this.len); this.len += 8; }
  writeUTF(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 1 && c <= 0x7f) bytes.push(c);
      else if (c <= 0x7ff) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    if (bytes.length > 65535) throw new Error('encoded string too long: ' + bytes.length + ' bytes');
    this.writeShort(bytes.length);
    this.write(bytes);
  }
  toBuffer() { return this.buf.subarray(0, this.len); }
}

// Properties.load over text (a stream is read as ISO-8859-1, so pass
// buf.toString('latin1') for that case). Returns a Map in file order;
// later duplicates replace earlier values.
function loadProperties(text) {
  const map = new Map();
  const n = text.length;
  const isWs = c => c === ' ' || c === '\t' || c === '\f';
  let i = 0;
  while (i < n) {
    let c = text[i];
    if (isWs(c) || c === '\n' || c === '\r') { i++; continue; }
    if (c === '#' || c === '!') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    // one logical line; segStart = start of the current natural line in it
    let line = '';
    let segStart = 0;
    while (i < n) {
      c = text[i];
      if (c === '\n' || c === '\r') {
        let bs = 0;
        for (let k = line.length - 1; k >= segStart && line[k] === '\\'; k--) bs++;
        if (bs % 2 === 0) break;
        line = line.slice(0, -1);
        i++;
        if (c === '\r' && text[i] === '\n') i++;
        while (i < n && isWs(text[i])) i++;
        segStart = line.length;
        continue;
      }
      line += c;
      i++;
    }
    if (i >= n) {
      let bs = 0;
      for (let k = line.length - 1; k >= segStart && line[k] === '\\'; k--) bs++;
      if (bs % 2 === 1) line = line.slice(0, -1);
    }
    const limit = line.length;
    let keyLen = 0, valueStart = limit, hasSep = false, preceding = false;
    while (keyLen < limit) {
      c = line[keyLen];
      if ((c === '=' || c === ':') && !preceding) { valueStart = keyLen + 1; hasSep = true; break; }
      if (isWs(c) && !preceding) { valueStart = keyLen + 1; break; }
      preceding = c === '\\' ? !preceding : false;
      keyLen++;
    }
    while (valueStart < limit) {
      c = line[valueStart];
      if (!isWs(c)) {
        if (!hasSep && (c === '=' || c === ':')) hasSep = true;
        else break;
      }
      valueStart++;
    }
    map.set(loadConvert(line.slice(0, keyLen)), loadConvert(line.slice(valueStart)));
  }
  return map;
}

function loadConvert(s) {
  let out = '';
  for (let i = 0; i < s.length;) {
    let c = s[i++];
    if (c === '\\') {
      c = s[i++];
      if (c === 'u') {
        if (i + 4 > s.length || !/^[0-9a-fA-F]{4}$/.test(s.substr(i, 4))) {
          throw new Error('Malformed \\uxxxx encoding.');
        }
        out += String.fromCharCode(parseInt(s.substr(i, 4), 16));
        i += 4;
      } else if (c === undefined) {
        break;
      } else {
        out += c === 't' ? '\t' : c === 'r' ? '\r' : c === 'n' ? '\n' : c === 'f' ? '\f' : c;
      }
    } else out += c;
  }
  return out;
}

module.exports = { stringHash, compareStrings, JHashMap, JHashSet, collectionCapacity, DataOutput, loadProperties };
