'use strict';
// Java's floating-point to integer conversions saturate (NaN is 0) and
// long-to-float rounds once, to nearest even. JS `| 0` wraps and
// Math.fround(Number(long)) rounds twice (through a double).

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const LONG_MIN = -9223372036854775808n;
const LONG_MAX = 9223372036854775807n;
const TWO_63 = 2 ** 63;

// d2i and f2i. Math.min/Math.max carry NaN through, and NaN | 0 is 0.
function toInt(value) {
  return Math.max(INT_MIN, Math.min(INT_MAX, value)) | 0;
}

// d2l and f2l.
function toLong(value) {
  if (value !== value) return 0n;
  if (value >= TWO_63) return LONG_MAX;
  if (value <= -TWO_63) return LONG_MIN;
  return BigInt(Math.trunc(value));
}

// l2f: round to odd at 53 bits, so the one rounding to 24 bits is exact.
function longToFloat(value) {
  const long = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
  const magnitude = long < 0n ? -long : long;
  if (magnitude < 0x20000000000000n) return Math.fround(Number(long));
  const shift = BigInt(magnitude.toString(2).length - 53);
  let top = magnitude >> shift;
  if ((magnitude & ((1n << shift) - 1n)) !== 0n) top |= 1n;
  const rounded = Number(top) * 2 ** Number(shift);
  return Math.fround(long < 0n ? -rounded : rounded);
}

module.exports = { toInt, toLong, longToFloat };
