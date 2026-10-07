'use strict';
// java.util.TreeMap (red-black tree) with a comparator. Reproduced node for
// node because the converter's KeyComparator is not transitive, so the
// iteration order depends on the tree's shape.

const RED = false, BLACK = true;
const colorOf = (p) => (p ? p.color : BLACK);
const parentOf = (p) => (p ? p.parent : null);
const setColor = (p, c) => { if (p) p.color = c; };
const leftOf = (p) => (p ? p.left : null);
const rightOf = (p) => (p ? p.right : null);

class JTreeMap {
  constructor(cmp) {
    this.cmp = cmp || ((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.root = null;
    this.size = 0;
  }

  getEntry(key) {
    let p = this.root;
    while (p) {
      const c = this.cmp(key, p.key);
      if (c < 0) p = p.left;
      else if (c > 0) p = p.right;
      else return p;
    }
    return null;
  }

  get(key) { const e = this.getEntry(key); return e ? e.value : undefined; }
  has(key) { return this.getEntry(key) !== null; }

  put(key, value, onlyIfAbsent) {
    let t = this.root;
    if (!t) {
      this.root = { key, value, left: null, right: null, parent: null, color: BLACK };
      this.size = 1;
      return undefined;
    }
    let parent, c;
    do {
      parent = t;
      c = this.cmp(key, t.key);
      if (c < 0) t = t.left;
      else if (c > 0) t = t.right;
      else {
        const old = t.value;
        if (!onlyIfAbsent || old === null || old === undefined) t.value = value;
        return old;
      }
    } while (t);
    const e = { key, value, left: null, right: null, parent, color: BLACK };
    if (c < 0) parent.left = e; else parent.right = e;
    this.fixAfterInsertion(e);
    this.size++;
    return undefined;
  }

  putIfAbsent(key, value) { return this.put(key, value, true); }

  remove(key) {
    const p = this.getEntry(key);
    if (!p) return undefined;
    const old = p.value;
    this.deleteEntry(p);
    return old;
  }

  rotateLeft(p) {
    if (!p) return;
    const r = p.right;
    p.right = r.left;
    if (r.left) r.left.parent = p;
    r.parent = p.parent;
    if (!p.parent) this.root = r;
    else if (p.parent.left === p) p.parent.left = r;
    else p.parent.right = r;
    r.left = p;
    p.parent = r;
  }

  rotateRight(p) {
    if (!p) return;
    const l = p.left;
    p.left = l.right;
    if (l.right) l.right.parent = p;
    l.parent = p.parent;
    if (!p.parent) this.root = l;
    else if (p.parent.right === p) p.parent.right = l;
    else p.parent.left = l;
    l.right = p;
    p.parent = l;
  }

  fixAfterInsertion(x) {
    x.color = RED;
    while (x && x !== this.root && x.parent.color === RED) {
      if (parentOf(x) === leftOf(parentOf(parentOf(x)))) {
        const y = rightOf(parentOf(parentOf(x)));
        if (colorOf(y) === RED) {
          setColor(parentOf(x), BLACK);
          setColor(y, BLACK);
          setColor(parentOf(parentOf(x)), RED);
          x = parentOf(parentOf(x));
        } else {
          if (x === rightOf(parentOf(x))) {
            x = parentOf(x);
            this.rotateLeft(x);
          }
          setColor(parentOf(x), BLACK);
          setColor(parentOf(parentOf(x)), RED);
          this.rotateRight(parentOf(parentOf(x)));
        }
      } else {
        const y = leftOf(parentOf(parentOf(x)));
        if (colorOf(y) === RED) {
          setColor(parentOf(x), BLACK);
          setColor(y, BLACK);
          setColor(parentOf(parentOf(x)), RED);
          x = parentOf(parentOf(x));
        } else {
          if (x === leftOf(parentOf(x))) {
            x = parentOf(x);
            this.rotateRight(x);
          }
          setColor(parentOf(x), BLACK);
          setColor(parentOf(parentOf(x)), RED);
          this.rotateLeft(parentOf(parentOf(x)));
        }
      }
    }
    this.root.color = BLACK;
  }

  static successor(t) {
    if (!t) return null;
    if (t.right) {
      let p = t.right;
      while (p.left) p = p.left;
      return p;
    }
    let p = t.parent, ch = t;
    while (p && ch === p.right) { ch = p; p = p.parent; }
    return p;
  }

  deleteEntry(p) {
    this.size--;
    if (p.left && p.right) {
      const s = JTreeMap.successor(p);
      p.key = s.key;
      p.value = s.value;
      p = s;
    }
    const replacement = p.left ? p.left : p.right;
    if (replacement) {
      replacement.parent = p.parent;
      if (!p.parent) this.root = replacement;
      else if (p === p.parent.left) p.parent.left = replacement;
      else p.parent.right = replacement;
      p.left = p.right = p.parent = null;
      if (p.color === BLACK) this.fixAfterDeletion(replacement);
    } else if (!p.parent) {
      this.root = null;
    } else {
      if (p.color === BLACK) this.fixAfterDeletion(p);
      if (p.parent) {
        if (p === p.parent.left) p.parent.left = null;
        else if (p === p.parent.right) p.parent.right = null;
        p.parent = null;
      }
    }
  }

  fixAfterDeletion(x) {
    while (x !== this.root && colorOf(x) === BLACK) {
      if (x === leftOf(parentOf(x))) {
        let sib = rightOf(parentOf(x));
        if (colorOf(sib) === RED) {
          setColor(sib, BLACK);
          setColor(parentOf(x), RED);
          this.rotateLeft(parentOf(x));
          sib = rightOf(parentOf(x));
        }
        if (colorOf(leftOf(sib)) === BLACK && colorOf(rightOf(sib)) === BLACK) {
          setColor(sib, RED);
          x = parentOf(x);
        } else {
          if (colorOf(rightOf(sib)) === BLACK) {
            setColor(leftOf(sib), BLACK);
            setColor(sib, RED);
            this.rotateRight(sib);
            sib = rightOf(parentOf(x));
          }
          setColor(sib, colorOf(parentOf(x)));
          setColor(parentOf(x), BLACK);
          setColor(rightOf(sib), BLACK);
          this.rotateLeft(parentOf(x));
          x = this.root;
        }
      } else {
        let sib = leftOf(parentOf(x));
        if (colorOf(sib) === RED) {
          setColor(sib, BLACK);
          setColor(parentOf(x), RED);
          this.rotateRight(parentOf(x));
          sib = leftOf(parentOf(x));
        }
        if (colorOf(rightOf(sib)) === BLACK && colorOf(leftOf(sib)) === BLACK) {
          setColor(sib, RED);
          x = parentOf(x);
        } else {
          if (colorOf(leftOf(sib)) === BLACK) {
            setColor(rightOf(sib), BLACK);
            setColor(sib, RED);
            this.rotateLeft(sib);
            sib = leftOf(parentOf(x));
          }
          setColor(sib, colorOf(parentOf(x)));
          setColor(parentOf(x), BLACK);
          setColor(leftOf(sib), BLACK);
          this.rotateRight(parentOf(x));
          x = this.root;
        }
      }
    }
    setColor(x, BLACK);
  }

  *entries() {
    let p = this.root;
    if (p) while (p.left) p = p.left;
    while (p) {
      const next = JTreeMap.successor(p);
      yield [p.key, p.value];
      p = next;
    }
  }

  *keys() { for (const [k] of this.entries()) yield k; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(fn) { for (const [k, v] of this.entries()) fn(v, k); }
  get isEmpty() { return this.size === 0; }
}

// java.util.TreeSet<String> (natural order is transitive, so a plain sorted set)
class JTreeSet {
  constructor(items) { this.set = new Set(items || []); }
  add(x) { const had = this.set.has(x); this.set.add(x); return !had; }
  addAll(xs) { for (const x of xs) this.add(x); }
  has(x) { return this.set.has(x); }
  delete(x) { return this.set.delete(x); }
  get size() { return this.set.size; }
  *[Symbol.iterator]() {
    yield* [...this.set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

module.exports = { JTreeMap, JTreeSet };
