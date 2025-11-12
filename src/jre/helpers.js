'use strict';

function withThrows(fn, exceptions) {
  if (Array.isArray(exceptions) && exceptions.length) {
    Object.defineProperty(fn, '__throws', {
      value: exceptions.slice(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return fn;
}

module.exports = { withThrows };
