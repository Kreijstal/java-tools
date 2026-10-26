'use strict';
// Float.toString / Double.toString as JDK 8-18 print them (FloatingDecimal's
// BinaryToASCIIBuffer.dtoa in "compatible" format). These are not the
// shortest round-trip digits: an exponent-form result always gets a second
// digit (Float.MIN_VALUE is 1.4E-45), and integral values with more bits
// than the significand keep rounded digits (2^31 as a float is
// 2.14748365E9).

const EXP_SHIFT = 52;
const MAX_SMALL_BIN_EXP = 62;
const MIN_SMALL_BIN_EXP = -21;
const N_5_BITS = [0, 3, 5, 7, 10, 12, 14, 17, 19, 21, 24, 26, 28, 31, 33, 35, 38, 40, 42, 45, 47, 49, 52, 54, 56, 59, 61];
const LONG_5_POW_LENGTH = 27;

const view = new DataView(new ArrayBuffer(8));

function n5bits(i) {
  return i < N_5_BITS.length ? N_5_BITS[i] : i * 3;
}

function trailingZeros64(value) {
  let n = 0;
  while (n < 64 && ((value >> BigInt(n)) & 1n) === 0n) n++;
  return n;
}

function leadingZeros64(value) {
  let n = 0;
  for (let bit = 63; bit >= 0 && ((value >> BigInt(bit)) & 1n) === 0n; bit--) n++;
  return n;
}

// floor((d2 - 1.5) * log10(2)-ish estimate), as FloatingDecimal.estimateDecExp.
function estimateDecExp(fractBits, binExp) {
  view.setBigUint64(0, 0x3ff0000000000000n | (fractBits & 0x000fffffffffffffn));
  const d2 = view.getFloat64(0);
  const d = (d2 - 1.5) * 0.289529654 + 0.176091259 + binExp * 0.301029995663981;
  return Math.floor(d);
}

function insignificantDigitsForPow2(p2) {
  return p2 > 1 && p2 < 64 ? Math.floor(p2 * Math.LOG10E * Math.LN2 + 1e-9) : 0;
}

// Digits of an integral value, low-order insignificant digits rounded away.
function developLongDigits(lvalue, insignificant) {
  let decExponent = 0;
  if (insignificant !== 0) {
    const pow10 = 10n ** BigInt(insignificant);
    const residue = lvalue % pow10;
    lvalue /= pow10;
    decExponent += insignificant;
    if (residue >= (pow10 >> 1n)) lvalue++;
  }
  let text = lvalue.toString();
  const length = text.length;
  text = text.replace(/0+$/, '');
  return { digits: text.split('').map(Number), decExponent: decExponent + length };
}

// signed wrap of the int/long arithmetic FloatingDecimal uses for m.
function wrap(bits, value) {
  return bits === 0 ? value : BigInt.asIntN(bits, value);
}

function dtoa(binExp, fractBits, nSignificantBits) {
  const tailZeros = trailingZeros64(fractBits);
  const nFractBits = EXP_SHIFT + 1 - tailZeros;
  const nTinyBits = Math.max(0, nFractBits - binExp - 1);
  if (binExp <= MAX_SMALL_BIN_EXP && binExp >= MIN_SMALL_BIN_EXP &&
      nTinyBits < LONG_5_POW_LENGTH && nFractBits + N_5_BITS[nTinyBits] < 64 && nTinyBits === 0) {
    const insignificant = binExp > nSignificantBits ? insignificantDigitsForPow2(binExp - nSignificantBits - 1) : 0;
    const lvalue = binExp >= EXP_SHIFT ? fractBits << BigInt(binExp - EXP_SHIFT) : fractBits >> BigInt(EXP_SHIFT - binExp);
    return developLongDigits(lvalue, insignificant);
  }
  let decExp = estimateDecExp(fractBits, binExp);
  const B5 = Math.max(0, -decExp);
  let B2 = B5 + nTinyBits + binExp;
  const S5 = Math.max(0, decExp);
  let S2 = S5 + nTinyBits;
  const M5 = B5;
  let M2 = B2 - nSignificantBits;
  const fract = fractBits >> BigInt(tailZeros);
  B2 -= nFractBits - 1;
  const common2 = Math.min(B2, S2);
  B2 -= common2; S2 -= common2; M2 -= common2;
  if (nFractBits === 1) M2 -= 1;
  if (M2 < 0) { B2 -= M2; S2 -= M2; M2 = 0; }

  const Bbits = nFractBits + B2 + n5bits(B5);
  const tenSbits = S2 + 1 + n5bits(S5 + 1);
  const digits = [];
  let low, high, lowDigitDifference;
  let b = fract * 5n ** BigInt(B5) << BigInt(B2);
  const s = 5n ** BigInt(S5) << BigInt(S2);
  let m = 5n ** BigInt(M5) << BigInt(M2);
  const tens = s * 10n;
  if (Bbits < 64 && tenSbits < 64) {
    // int (or long) arithmetic, overflow included: m and b + m wrap.
    const bits = Bbits < 32 && tenSbits < 32 ? 32 : 64;
    let q = b / s;
    b = 10n * (b % s);
    m = wrap(bits, m * 10n);
    low = b < m;
    high = wrap(bits, b + m) > tens;
    if (q === 0n && !high) decExp--;
    else digits.push(Number(q));
    if (decExp < -3 || decExp >= 8) high = low = false;
    while (!low && !high) {
      q = b / s;
      b = 10n * (b % s);
      m = wrap(bits, m * 10n);
      if (m > 0n) {
        low = b < m;
        high = wrap(bits, b + m) > tens;
      } else {
        low = true; high = true;
      }
      digits.push(Number(q));
    }
    lowDigitDifference = wrap(bits, (b << 1n) - tens);
  } else {
    let q = b / s;
    b = 10n * (b % s);
    m *= 10n;
    low = b < m;
    high = b + m >= tens;
    if (q === 0n && !high) decExp--;
    else digits.push(Number(q));
    if (decExp < -3 || decExp >= 8) high = low = false;
    while (!low && !high) {
      q = b / s;
      b = 10n * (b % s);
      m *= 10n;
      low = b < m;
      high = b + m >= tens;
      digits.push(Number(q));
    }
    lowDigitDifference = high && low ? (b << 1n) - tens : 0n;
  }
  const result = { digits, decExponent: decExp + 1 };
  if (high) {
    if (low) {
      if (lowDigitDifference === 0n) {
        if (digits[digits.length - 1] & 1) roundup(result);
      } else if (lowDigitDifference > 0n) {
        roundup(result);
      }
    } else {
      roundup(result);
    }
  }
  return result;
}

function roundup(result) {
  const { digits } = result;
  let i = digits.length - 1;
  let q = digits[i];
  if (q === 9) {
    while (q === 9 && i > 0) {
      digits[i] = 0;
      q = digits[--i];
    }
    if (q === 9) {
      result.decExponent += 1;
      digits[0] = 1;
      return;
    }
  }
  digits[i] = q + 1;
}

function format(negative, { digits, decExponent }) {
  let out = negative ? '-' : '';
  const nDigits = digits.length;
  const text = digits.join('');
  if (decExponent > 0 && decExponent < 8) {
    const charLength = Math.min(nDigits, decExponent);
    out += text.slice(0, charLength);
    if (charLength < decExponent) {
      out += '0'.repeat(decExponent - charLength) + '.0';
    } else {
      out += '.' + (charLength < nDigits ? text.slice(charLength) : '0');
    }
  } else if (decExponent <= 0 && decExponent > -3) {
    out += '0.' + '0'.repeat(-decExponent) + text;
  } else {
    out += text[0] + '.' + (nDigits > 1 ? text.slice(1) : '0') + 'E';
    out += decExponent <= 0 ? '-' + (-decExponent + 1) : String(decExponent - 1);
  }
  return out;
}

function special(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  return null;
}

function javaDoubleString(value) {
  const d = Number(value);
  const text = special(d);
  if (text !== null) return text;
  view.setFloat64(0, d);
  const bits = view.getBigUint64(0);
  let fractBits = bits & 0x000fffffffffffffn;
  let binExp = Number((bits >> 52n) & 0x7ffn);
  let nSignificantBits;
  if (binExp === 0) {
    const leadingZeros = leadingZeros64(fractBits);
    const shift = leadingZeros - (63 - EXP_SHIFT);
    fractBits <<= BigInt(shift);
    binExp = 1 - shift;
    nSignificantBits = 64 - leadingZeros;
  } else {
    fractBits |= 0x0010000000000000n;
    nSignificantBits = EXP_SHIFT + 1;
  }
  return format(d < 0, dtoa(binExp - 1023, fractBits, nSignificantBits));
}

function javaFloatString(value) {
  const f = Math.fround(Number(value));
  const text = special(f);
  if (text !== null) return text;
  view.setFloat32(0, f);
  const bits = view.getUint32(0);
  let fractBits = bits & 0x7fffff;
  let binExp = (bits >>> 23) & 0xff;
  let nSignificantBits;
  if (binExp === 0) {
    const leadingZeros = Math.clz32(fractBits);
    const shift = leadingZeros - (31 - 23);
    fractBits <<= shift;
    binExp = 1 - shift;
    nSignificantBits = 32 - leadingZeros;
  } else {
    fractBits |= 0x800000;
    nSignificantBits = 24;
  }
  return format(f < 0, dtoa(binExp - 127, BigInt(fractBits) << BigInt(EXP_SHIFT - 23), nSignificantBits));
}

module.exports = { javaDoubleString, javaFloatString };
