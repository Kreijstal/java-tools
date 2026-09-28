"use strict";

// Class parsing and structured cloning duplicate bytecode names and type
// descriptors. Share their string values without retaining the class graphs.
// The cap also bounds retention across many unrelated classes.
class ClassDataStrings {
  constructor({ maxEntries = 65536, maxLength = 128 } = {}) {
    for (const value of [maxEntries, maxLength]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("String sharing limits must be nonnegative integers");
      }
    }
    this.maxEntries = maxEntries;
    this.maxLength = maxLength;
    this.values = new Map();
  }

  share(root) {
    const seen = new WeakSet();
    const pending = [root];
    while (pending.length) {
      const object = pending.pop();
      if (!object || typeof object !== "object" || seen.has(object)) continue;
      // Class ASTs and constant pools contain plain records and arrays. Leave
      // binary buffers and other transport objects untouched.
      const prototype = Object.getPrototypeOf(object);
      if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) continue;
      seen.add(object);
      for (const key of Object.keys(object)) {
        const value = object[key];
        if (typeof value === "string" && value.length <= this.maxLength) {
          if (this.values.has(value)) object[key] = this.values.get(value);
          else if (this.values.size < this.maxEntries) this.values.set(value, value);
        } else if (value && typeof value === "object") pending.push(value);
      }
    }
    return root;
  }
}

module.exports = { ClassDataStrings };
