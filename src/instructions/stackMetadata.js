'use strict';

// Shared, non-serialized metadata attached to a parsed bytecode item after
// verifier-style kind analysis. The array is ordered from the bottom of the
// operand stack to the top and contains JVM value widths (1 or 2).
const stackWidthsBefore = Symbol('stackWidthsBefore');

module.exports = {
  stackWidthsBefore,
};
