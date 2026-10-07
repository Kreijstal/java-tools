'use strict';
// java.util.HashMap/HashSet with String keys, reproducing the JDK's bucket
// layout so that iteration order matches Java exactly. Tree bins are not
// emulated; growing a bin far enough to be treeified throws.

function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function spread(key) {
  const h = stringHash(key);
  return h ^ (h >>> 16);
}

function tableSizeFor(cap) {
  let n = 1;
  while (n < cap) n *= 2;
  return Math.max(n, 1);
}

const TREEIFY_THRESHOLD = 8;
const MIN_TREEIFY_CAPACITY = 64;

class JHashMap {
  // initialCapacity as given to new HashMap<>(n)
  constructor(initialCapacity) {
    this.table = null;
    this.size = 0;
    this.threshold = initialCapacity === undefined ? 0 : tableSizeFor(initialCapacity);
    if (initialCapacity === 0) this.threshold = 1;
  }

  // HashMap.newHashMap(n)
  static newHashMap(n) { return new JHashMap(Math.ceil(n / 0.75)); }

  // new HashMap<>(otherMap)
  static copyOf(m) {
    const r = new JHashMap();
    r.putAll(m);
    return r;
  }

  resize() {
    const oldTab = this.table;
    const oldCap = oldTab ? oldTab.length : 0;
    const oldThr = this.threshold;
    let newCap, newThr = 0;
    if (oldCap > 0) {
      newCap = oldCap * 2;
      if (oldCap >= 16) newThr = oldThr * 2;
    } else if (oldThr > 0) newCap = oldThr;
    else { newCap = 16; newThr = 12; }
    if (newThr === 0) newThr = Math.floor(newCap * 0.75);
    this.threshold = newThr;
    const newTab = new Array(newCap).fill(null);
    this.table = newTab;
    if (oldTab) {
      for (let j = 0; j < oldCap; j++) {
        let e = oldTab[j];
        if (!e) continue;
        let loH = null, loT = null, hiH = null, hiT = null;
        while (e) {
          const next = e.next;
          if ((e.hash & oldCap) === 0) { if (loT) loT.next = e; else loH = e; loT = e; }
          else { if (hiT) hiT.next = e; else hiH = e; hiT = e; }
          e = next;
        }
        if (loT) { loT.next = null; newTab[j] = loH; }
        if (hiT) { hiT.next = null; newTab[j + oldCap] = hiH; }
      }
    }
    return newTab;
  }

  findNode(key) {
    if (!this.table) return null;
    const h = spread(key);
    for (let e = this.table[h & (this.table.length - 1)]; e; e = e.next) {
      if (e.hash === h && e.key === key) return e;
    }
    return null;
  }

  treeifyBin() {
    if (this.table.length < MIN_TREEIFY_CAPACITY) this.resize();
    else throw new Error('JHashMap: tree bins are not emulated');
  }

  // putVal; returns the previous value
  put(key, value, onlyIfAbsent) {
    if (!this.table || this.table.length === 0) this.resize();
    const h = spread(key);
    const tab = this.table;
    const i = h & (tab.length - 1);
    let p = tab[i];
    if (!p) {
      tab[i] = { hash: h, key, value, next: null };
    } else {
      let binCount = 0;
      for (;;) {
        if (p.hash === h && p.key === key) {
          const old = p.value;
          if (!onlyIfAbsent || old === null || old === undefined) p.value = value;
          return old;
        }
        if (!p.next) {
          p.next = { hash: h, key, value, next: null };
          if (binCount >= TREEIFY_THRESHOLD - 1) this.treeifyBin();
          break;
        }
        p = p.next;
        binCount++;
      }
    }
    if (++this.size > this.threshold) this.resize();
    return undefined;
  }

  putIfAbsent(key, value) { return this.put(key, value, true); }

  // insertion path of computeIfAbsent/compute/merge (resize first, head insert)
  _insertHead(key, value) {
    if (this.size > this.threshold || !this.table || this.table.length === 0) this.resize();
    const h = spread(key);
    const tab = this.table;
    const i = h & (tab.length - 1);
    let binCount = 0;
    for (let e = tab[i]; e; e = e.next) binCount++;
    tab[i] = { hash: h, key, value, next: tab[i] };
    if (binCount >= TREEIFY_THRESHOLD - 1) this.treeifyBin();
    this.size++;
  }

  computeIfAbsent(key, fn) {
    if (this.size > this.threshold || !this.table || this.table.length === 0) this.resize();
    const e = this.findNode(key);
    if (e && e.value !== null && e.value !== undefined) return e.value;
    const v = fn(key);
    if (v === null || v === undefined) return v;
    if (e) { e.value = v; return v; }
    this._insertHead(key, v);
    return v;
  }

  merge(key, value, fn) {
    if (this.size > this.threshold || !this.table || this.table.length === 0) this.resize();
    const e = this.findNode(key);
    if (e) {
      const v = e.value !== null && e.value !== undefined ? fn(e.value, value) : value;
      if (v === null || v === undefined) this.remove(key);
      else e.value = v;
      return v;
    }
    this._insertHead(key, value);
    return value;
  }

  get(key) {
    const e = this.findNode(key);
    return e ? e.value : undefined;
  }

  getOrDefault(key, def) {
    const e = this.findNode(key);
    return e ? e.value : def;
  }

  has(key) { return this.findNode(key) !== null; }

  remove(key) {
    if (!this.table) return undefined;
    const h = spread(key);
    const i = h & (this.table.length - 1);
    let prev = null;
    for (let e = this.table[i]; e; prev = e, e = e.next) {
      if (e.hash === h && e.key === key) {
        if (prev) prev.next = e.next; else this.table[i] = e.next;
        this.size--;
        return e.value;
      }
    }
    return undefined;
  }

  putAll(m) {
    const s = m.size;
    if (s > 0) {
      if (!this.table) {
        const t = Math.ceil(s / 0.75);
        if (t > this.threshold) this.threshold = tableSizeFor(t);
      } else {
        while (s > this.threshold) this.resize();
      }
      for (const [k, v] of m.entries()) this.put(k, v);
    }
  }

  *entries() {
    if (!this.table) return;
    // snapshot per bucket so that removal of the current entry is safe
    for (let i = 0; i < this.table.length; i++) {
      for (let e = this.table[i]; e; e = e.next) yield [e.key, e.value];
    }
  }

  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator]() { return this.entries(); }

  forEach(fn) { for (const [k, v] of this.entries()) fn(v, k); }

  containsValue(v) {
    for (const [, x] of this.entries()) if (x === v) return true;
    return false;
  }

  get length() { return this.size; }
}

class JHashSet {
  constructor(initialCapacity) { this.map = new JHashMap(initialCapacity); }
  // new HashSet<>(collection)
  static of(items) {
    const arr = [...items];
    const s = new JHashSet();
    s.map = JHashMap.newHashMap(Math.max(arr.length, 12));
    for (const x of arr) s.add(x);
    return s;
  }
  add(x) { return this.map.put(x, true) === undefined; }
  has(x) { return this.map.has(x); }
  delete(x) { return this.map.remove(x) !== undefined; }
  get size() { return this.map.size; }
  *[Symbol.iterator]() { yield* this.map.keys(); }
  forEach(fn) { for (const k of this.map.keys()) fn(k); }
}

module.exports = { JHashMap, JHashSet, stringHash };
