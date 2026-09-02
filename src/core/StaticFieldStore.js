"use strict";

// Static field storage for one class.  It is a Map keyed by
// "name:descriptor" (the historical representation every loader, interpreter
// path, and JRE stub writes through), extended with per-key value cells so
// generated code can read a resolved static field with one property load
// instead of a string-keyed Map lookup on every call.  A cell is created on
// first request and thereafter mirrors every write made through the Map API,
// so a cell reader observes exactly what Map.get would return.
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
      cell = { value: super.get(key) };
      this.cells.set(key, cell);
    }
    return cell;
  }

  set(key, value) {
    super.set(key, value);
    const cell = this.cells && this.cells.get(key);
    if (cell) cell.value = value;
    return this;
  }

  delete(key) {
    const removed = super.delete(key);
    const cell = this.cells && this.cells.get(key);
    if (cell) cell.value = undefined;
    return removed;
  }

  clear() {
    super.clear();
    if (this.cells) {
      for (const cell of this.cells.values()) cell.value = undefined;
    }
  }
}

module.exports = { StaticFieldStore };
