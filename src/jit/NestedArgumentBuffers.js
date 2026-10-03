'use strict';

// Keep at most one idle argument array per live module metadata object.
// Recursive entries get temporary buffers, so a nested call cannot overwrite
// its caller's arguments. Clear every slot before making a buffer reusable.
class NestedArgumentBuffers {
  constructor() {
    this.buffers = new WeakMap();
  }

  acquire(moduleMeta, length) {
    let buffer = this.buffers.get(moduleMeta);
    if (!buffer || buffer.values.length !== length) {
      buffer = {values: new Array(length), inUse: false};
      this.buffers.set(moduleMeta, buffer);
    } else if (buffer.inUse) {
      buffer = {values: new Array(length), inUse: false};
    }
    buffer.inUse = true;
    return buffer;
  }

  release(buffer) {
    // A numeric clear also releases references without forcing a numeric
    // backing store into generic object elements between invocations.
    buffer.values.fill(0);
    buffer.inUse = false;
  }
}

module.exports = NestedArgumentBuffers;
