"use strict";

// Static field storage for one class.  It is a Map keyed by
// "name:descriptor" (the historical representation every loader, interpreter
// path, and JRE stub writes through), extended with per-key value cells so
// generated code can read and write a resolved static field with one
// property access instead of a string-keyed Map lookup on every access.
//
// Once a cell exists for a key it is the value of record: generated code
// writes `cell.value` directly (a Map.set per static write was 2% of a Deko
// Bloko frame, on top of the get per read), and every Map-side reader below
// consults the cell first, so a Map reader observes exactly what the last
// writer stored whichever side wrote it. The Map keeps owning key existence
// (`has`, `keys`, `size`) and the value of keys that no cell has claimed.
// `present` mirrors that membership so resolved writers can avoid a keyed
// lookup while still restoring a key after deletion or a cold first write.
class StaticFieldStore extends Map {
  constructor(entries) {
    super();
    this.cells = new Map();
    if (entries) {
      for (const [key, value] of entries) this.set(key, value);
    }
  }

  cell(key) {
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { value: super.get(key), present: super.has(key) };
      this.cells.set(key, cell);
      // Once the cell owns the value, the Map only tracks membership. Keeping
      // its original value would retain replaced arrays/objects indefinitely.
      if (cell.present) super.set(key, undefined);
    }
    return cell;
  }

  get(key) {
    const cell = this.cells.get(key);
    return cell !== undefined ? cell.value : super.get(key);
  }

  set(key, value) {
    const cell = this.cells.get(key);
    if (cell !== undefined) {
      cell.value = value;
      if (!super.has(key)) super.set(key, undefined);
      cell.present = true;
    } else {
      super.set(key, value);
    }
    return this;
  }

  delete(key) {
    const removed = super.delete(key);
    const cell = this.cells.get(key);
    if (cell) {
      cell.value = undefined;
      cell.present = false;
    }
    return removed;
  }

  clear() {
    super.clear();
    for (const cell of this.cells.values()) {
      cell.value = undefined;
      cell.present = false;
    }
  }

  *entries() {
    for (const key of super.keys()) yield [key, this.get(key)];
  }

  *values() {
    for (const key of super.keys()) yield this.get(key);
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(callback, thisArg) {
    for (const key of super.keys()) callback.call(thisArg, this.get(key), key, this);
  }
}

module.exports = { StaticFieldStore };
