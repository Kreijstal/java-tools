'use strict';
// Port of make/jdk/src/classes/build/tools/intpoly/FieldGen.java, which
// generates the sun.security.util.math.intpoly finite field classes.
//
// usage: FieldGen header.txt destroot
const fs = require('fs');
const path = require('path');
const { LNSEP, splitLines } = require('./util');
const { JHashSet } = require('./misc-java');

const term = (power, coefficient) => ({ power, coefficient });
const carry = index => ({ kind: 'carry', index });
const reduce = index => ({ kind: 'reduce', index });

function fullCarry(n) {
  const r = [];
  for (let i = 0; i < n - 1; i++) r.push(carry(i));
  return r;
}
function fullReduce(n) {
  const r = [];
  for (let i = n - 2; i >= 0; i--) r.push(reduce(i + n));
  return r;
}
function simpleSmallCrSequence(n) {
  const r = [];
  for (let i = n - 2; i < n; i++) r.push(carry(i));
  r.push(reduce(n));
  return r.concat(fullCarry(n));
}
function curve448CrSequence() {
  const r = [];
  for (let i = 24; i < 31; i++) r.push(reduce(i));
  for (let i = 20; i < 24; i++) r.push(reduce(i));
  r.push(carry(14), carry(15));
  for (let i = 16; i < 20; i++) r.push(reduce(i));
  return r.concat(fullCarry(16));
}
const pCrSequence = n => fullReduce(n).concat(simpleSmallCrSequence(n));
function o521crSequence(n) {
  const r = fullCarry(2 * n);
  for (let i = 2 * n - 1; i >= n + Math.trunc(n / 2); i--) r.push(reduce(i));
  for (let i = n; i < n + Math.trunc(n / 2) - 1; i++) r.push(carry(i));
  for (let i = n + Math.trunc(n / 2) - 1; i >= n; i--) r.push(reduce(i));
  return r.concat(orderFieldSmallCrSequence(n));
}
function orderFieldCrSequence(n) {
  return [...fullCarry(2 * n), reduce(2 * n - 1), ...fullReduce(n),
    ...fullCarry(n + 1), reduce(n), ...fullCarry(n)];
}
function orderFieldSmallCrSequence(n) {
  return [...fullCarry(n + 1), reduce(n), ...fullCarry(n)];
}

// split a large subtrahend into smaller terms that are aligned with limbs
function buildTerms(sub, bitsPerLimb) {
  let negate = false;
  if (sub < 0n) { negate = true; sub = -sub; }
  const result = [];
  const mod = BigInt(1 << bitsPerLimb);
  let termIndex = 0;
  while (sub !== 0n) {
    let coef = Number(((sub % mod) + mod) % mod);
    let plusOne = false;
    if (coef > (1 << (bitsPerLimb - 1))) { coef -= 1 << bitsPerLimb; plusOne = true; }
    if (negate) coef = 0 - coef;
    if (coef !== 0) result.push(term(termIndex * bitsPerLimb, -coef));
    sub >>= BigInt(bitsPerLimb);
    if (plusOne) sub += 1n;
    ++termIndex;
  }
  return result;
}

function field(className, bitsPerLimb, numLimbs, maxAdds, power, terms, crSequence, smallCrSequence) {
  if (typeof terms === 'string') {
    terms = buildTerms((1n << BigInt(power)) - BigInt('0x' + terms), bitsPerLimb);
  }
  return { className, bitsPerLimb, numLimbs, maxAdds, power, terms, crSequence, smallCrSequence };
}

const ALL_FIELDS = [
  field('IntegerPolynomial448', 28, 16, 1, 448, [term(224, -1), term(0, -1)],
    curve448CrSequence(), simpleSmallCrSequence(16)),
  field('IntegerPolynomialP256', 26, 10, 2, 256,
    [term(224, -1), term(192, 1), term(96, 1), term(0, -1)], pCrSequence(10), simpleSmallCrSequence(10)),
  field('IntegerPolynomialP384', 28, 14, 2, 384,
    [term(128, -1), term(96, -1), term(32, 1), term(0, -1)], pCrSequence(14), simpleSmallCrSequence(14)),
  field('IntegerPolynomialP521', 28, 19, 2, 521, [term(0, -1)], pCrSequence(19), simpleSmallCrSequence(19)),
  field('P256OrderField', 26, 10, 1, 256,
    'FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551',
    orderFieldCrSequence(10), orderFieldSmallCrSequence(10)),
  field('P384OrderField', 28, 14, 1, 384,
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC7634D81F4372DDF581A0DB248B0A77AECEC196ACCC52973',
    orderFieldCrSequence(14), orderFieldSmallCrSequence(14)),
  field('P521OrderField', 28, 19, 1, 521,
    '01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA51868783BF2F966B7FCC0148F709A5D03BB5C9B8899C47AEBB6FB71E91386409',
    o521crSequence(19), orderFieldSmallCrSequence(19)),
  field('Curve25519OrderField', 26, 10, 1, 252,
    '1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed',
    orderFieldCrSequence(10), orderFieldSmallCrSequence(10)),
  field('Curve448OrderField', 28, 16, 1, 446,
    '3fffffffffffffffffffffffffffffffffffffffffffffffffffffff7cca23e9c44edb49aed63690216cc2728dc58f552378c292ab5844f3',
    orderFieldCrSequence(16), orderFieldSmallCrSequence(16)),
];

class CodeBuffer {
  constructor() {
    this.nextTemporary = 0;
    this.temporaries = new JHashSet();
    this.buffer = '';
    this.indent = 0;
    this.lastCR = null;
    this.lastCrCount = 0;
    this.crMethodBreakCount = 0;
    this.crNumLimbs = 0;
  }
  incrIndent() { this.indent++; }
  decrIndent() { this.indent--; }
  newTempScope() { this.nextTemporary = 0; this.temporaries.clear(); }
  appendLine(s) {
    if (s === undefined) { this.buffer += '\n'; return; }
    this.appendIndent();
    this.buffer += s + '\n';
  }
  startCrSequence(numLimbs) {
    this.crNumLimbs = numLimbs;
    this.lastCrCount = 0;
    this.crMethodBreakCount = 0;
    this.lastCR = null;
  }
  // break up long carry/reduce runs into separate methods
  record(type) {
    if (type === this.lastCR) {
      this.lastCrCount++;
    } else {
      if (this.lastCrCount >= 8) this.insertCrMethodBreak();
      this.lastCR = type;
      this.lastCrCount = 0;
    }
  }
  insertCrMethodBreak() {
    this.appendLine();
    this.appendIndent();
    this.append('carryReduce' + this.crMethodBreakCount + '(r');
    for (let i = 0; i < this.crNumLimbs; i++) this.append(', c' + i);
    this.append(');\n');
    this.decrIndent();
    this.appendLine('}');
    this.appendIndent();
    this.append('void carryReduce' + this.crMethodBreakCount + '(long[] r');
    for (let i = 0; i < this.crNumLimbs; i++) this.append(', long c' + i);
    this.append(') {\n');
    this.incrIndent();
    for (const temp of this.temporaries) this.appendLine('long ' + temp + ';');
    this.append('\n');
    this.crMethodBreakCount++;
  }
  getTemporary(type, value) {
    const vals = this.temporaries.values();
    if (vals.length) {
      const result = vals[0];
      this.temporaries.delete(result);
      this.appendLine(result + ' = ' + value + ';');
      return result;
    }
    const result = 't' + (this.nextTemporary++);
    this.appendLine(type + ' ' + result + ' = ' + value + ';');
    return result;
  }
  freeTemporary(temp) { this.temporaries.add(temp); }
  appendIndent() { this.buffer += '    '.repeat(this.indent); }
  append(s) { this.buffer += s; }
}

const indexedExpr = (isArray, prefix, index) => isArray ? `${prefix}[${index}]` : prefix + index;

function modReduceInBits(result, params, isArray, prefix, index, reduceBits, coefficient, c) {
  let x = coefficient + ' * ' + c;
  let accOp = '+=';
  let temp = null;
  if (coefficient === 1) {
    x = c;
  } else if (coefficient === -1) {
    x = c;
    accOp = '-=';
  } else {
    temp = result.getTemporary('long', x);
    x = temp;
  }
  const bpl = params.bitsPerLimb;
  if (reduceBits % bpl === 0) {
    const pos = Math.trunc(reduceBits / bpl);
    result.appendLine(indexedExpr(isArray, prefix, index - pos) + ' ' + accOp + ' ' + x + ';');
  } else {
    const secondPos = Math.trunc(reduceBits / bpl);
    const bitOffset = (secondPos + 1) * bpl - reduceBits;
    const rightBitOffset = bpl - bitOffset;
    result.appendLine(indexedExpr(isArray, prefix, index - (secondPos + 1)) + ' ' + accOp
      + ' (' + x + ' << ' + bitOffset + ') & LIMB_MASK;');
    result.appendLine(indexedExpr(isArray, prefix, index - secondPos) + ' ' + accOp + ' ' + x
      + ' >> ' + rightBitOffset + ';');
  }
  if (temp !== null) result.freeTemporary(temp);
}

function writeReduce(out, params, prefix, index, remaining) {
  out.record('reduce');
  out.appendLine('//reduce from position ' + index);
  const reduceFrom = indexedExpr(false, prefix, index);
  const referenced = remaining.some(cr => cr.index === index);
  for (const t of params.terms) {
    modReduceInBits(out, params, false, prefix, index, params.power - t.power, -1 * t.coefficient, reduceFrom);
  }
  if (referenced) out.appendLine(reduceFrom + ' = 0;');
}

function writeCarry(out, params, prefix, index) {
  out.record('carry');
  out.appendLine('//carry from position ' + index);
  const carryFrom = prefix + index;
  const carryTo = prefix + (index + 1);
  const temp = out.getTemporary('long', '(' + carryFrom + ' + CARRY_ADD) >> ' + params.bitsPerLimb);
  out.appendLine(carryFrom + ' -= (' + temp + ' << ' + params.bitsPerLimb + ');');
  out.appendLine(carryTo + ' += ' + temp + ';');
  out.freeTemporary(temp);
}

function writeSequence(out, sequence, params, prefix, numLimbs) {
  out.startCrSequence(numLimbs);
  sequence.forEach((cr, i) => {
    if (cr.kind === 'carry') writeCarry(out, params, prefix, cr.index);
    else writeReduce(out, params, prefix, cr.index, sequence.slice(i + 1));
  });
}

function carryReduceArgs(result, n, fn) {
  for (let i = 0; i < n; i++) {
    result.append(fn(i));
    if (i < n - 1) result.append(', ');
  }
}

function generate(params, header, packageName, parentName) {
  const result = new CodeBuffer();
  const { className, bitsPerLimb, numLimbs, power, terms } = params;
  result.appendLine(header);
  if (packageName !== null) {
    result.appendLine('package ' + packageName + ';');
    result.appendLine();
  }
  result.appendLine('import java.math.BigInteger;');
  result.appendLine('public final class ' + className + ' extends ' + parentName + ' {');
  result.incrIndent();
  result.appendLine('private static final int BITS_PER_LIMB = ' + bitsPerLimb + ';');
  result.appendLine('private static final int NUM_LIMBS = ' + numLimbs + ';');
  result.appendLine('private static final int MAX_ADDS = ' + params.maxAdds + ';');
  result.appendLine('public static final BigInteger MODULUS = evaluateModulus();');
  result.appendLine('private static final long CARRY_ADD = 1 << ' + (bitsPerLimb - 1) + ';');
  if (bitsPerLimb * numLimbs !== power) {
    result.appendLine('private static final long LIMB_MASK = -1L >>> (64 - BITS_PER_LIMB);');
  }
  result.appendLine();
  result.appendLine('public static final ' + className + ' ONE = new ' + className + '();');
  result.appendLine();
  result.appendLine('private ' + className + '() {');
  result.appendLine();
  result.appendLine('    super(BITS_PER_LIMB, NUM_LIMBS, MAX_ADDS, MODULUS);');
  result.appendLine();
  result.appendLine('}');

  let coqTerms = '//';
  for (const t of terms) coqTerms += '(' + t.power + '%nat,' + t.coefficient + ')::';
  result.appendLine(coqTerms + 'nil.');

  result.appendLine('private static BigInteger evaluateModulus() {');
  result.incrIndent();
  result.appendLine('BigInteger result = BigInteger.valueOf(2).pow(' + power + ');');
  for (const t of terms) {
    const subtract = t.coefficient < 0;
    const coefExpr = 'BigInteger.valueOf(' + Math.abs(t.coefficient) + ')';
    const termExpr = t.power === 0 ? coefExpr : coefExpr + '.shiftLeft(' + t.power + ')';
    result.appendLine('result = result.' + (subtract ? 'subtract' : 'add') + '(' + termExpr + ');');
  }
  result.appendLine('return result;');
  result.decrIndent();
  result.appendLine('}');

  result.appendLine('@Override');
  result.appendLine('protected void reduceIn(long[] limbs, long v, int i) {');
  result.incrIndent();
  for (const t of terms) {
    const reduceBits = power - t.power;
    const coefficient = -1 * t.coefficient;
    let x = coefficient + ' * v';
    let accOp = '+=';
    if (coefficient === 1) {
      x = 'v';
    } else if (coefficient === -1) {
      x = 'v';
      accOp = '-=';
    } else {
      x = result.getTemporary('long', x);
    }
    if (reduceBits % bitsPerLimb === 0) {
      result.appendLine('limbs[i - ' + Math.trunc(reduceBits / bitsPerLimb) + '] ' + accOp + ' ' + x + ';');
    } else {
      const secondPos = Math.trunc(reduceBits / bitsPerLimb);
      const bitOffset = (secondPos + 1) * bitsPerLimb - reduceBits;
      const rightBitOffset = bitsPerLimb - bitOffset;
      result.appendLine('limbs[i - ' + (secondPos + 1) + '] ' + accOp + ' (' + x + ' << ' + bitOffset + ') & LIMB_MASK;');
      result.appendLine('limbs[i - ' + secondPos + '] ' + accOp + ' ' + x + ' >> ' + rightBitOffset + ';');
    }
  }
  result.decrIndent();
  result.appendLine('}');

  result.appendLine('@Override');
  result.appendLine('protected void finalCarryReduceLast(long[] limbs) {');
  result.incrIndent();
  const extraBits = bitsPerLimb * numLimbs - power;
  const highBits = bitsPerLimb - extraBits;
  result.appendLine('long c = limbs[' + (numLimbs - 1) + '] >> ' + highBits + ';');
  result.appendLine('limbs[' + (numLimbs - 1) + '] -= c << ' + highBits + ';');
  for (const t of terms) {
    modReduceInBits(result, params, true, 'limbs', numLimbs, power + extraBits - t.power, -1 * t.coefficient, 'c');
  }
  result.decrIndent();
  result.appendLine('}');

  // full carry/reduce sequence
  result.appendIndent();
  result.append('private void carryReduce(long[] r, ');
  carryReduceArgs(result, 2 * numLimbs - 1, i => 'long c' + i);
  result.append(') {\n');
  result.newTempScope();
  result.incrIndent();
  result.appendLine('long c' + (2 * numLimbs - 1) + ' = 0;');
  writeSequence(result, params.crSequence, params, 'c', 2 * numLimbs);
  result.appendLine();
  for (let i = 0; i < numLimbs; i++) result.appendLine('r[' + i + '] = c' + i + ';');
  result.decrIndent();
  result.appendLine('}');

  // small carry/reduce sequence
  result.appendIndent();
  result.append('private void carryReduce(long[] r, ');
  carryReduceArgs(result, numLimbs, i => 'long c' + i);
  result.append(') {\n');
  result.newTempScope();
  result.incrIndent();
  result.appendLine('long c' + numLimbs + ' = 0;');
  writeSequence(result, params.smallCrSequence, params, 'c', numLimbs + 1);
  result.appendLine();
  for (let i = 0; i < numLimbs; i++) result.appendLine('r[' + i + '] = c' + i + ';');
  result.decrIndent();
  result.appendLine('}');

  result.appendLine('@Override');
  result.appendLine('protected void mult(long[] a, long[] b, long[] r) {');
  result.incrIndent();
  for (let i = 0; i < 2 * numLimbs - 1; i++) {
    result.appendIndent();
    result.append('long c' + i + ' = ');
    const startJ = Math.max(i + 1 - numLimbs, 0);
    const endJ = Math.min(numLimbs, i + 1);
    for (let j = startJ; j < endJ; j++) {
      result.append('(a[' + j + '] * b[' + (i - j) + '])');
      if (j < endJ - 1) result.append(' + ');
    }
    result.append(';\n');
  }
  result.appendLine();
  result.appendIndent();
  result.append('carryReduce(r, ');
  carryReduceArgs(result, 2 * numLimbs - 1, i => 'c' + i);
  result.append(');\n');
  result.decrIndent();
  result.appendLine('}');

  result.appendLine('@Override');
  result.appendLine('protected void reduce(long[] a) {');
  result.incrIndent();
  result.appendIndent();
  result.append('carryReduce(a, ');
  carryReduceArgs(result, numLimbs, i => 'a[' + i + ']');
  result.append(');\n');
  result.decrIndent();
  result.appendLine('}');

  result.appendLine('@Override');
  result.appendLine('protected void square(long[] a, long[] r) {');
  result.incrIndent();
  for (let i = 0; i < 2 * numLimbs - 1; i++) {
    result.appendIndent();
    result.append('long c' + i + ' = ');
    const startJ = Math.max(i + 1 - numLimbs, 0);
    const endJ = Math.min(numLimbs, i + 1);
    const jDiff = endJ - startJ;
    const half = Math.trunc(jDiff / 2);
    if (jDiff > 1) result.append('2 * (');
    for (let j = 0; j < half; j++) {
      const aIndex = j + startJ;
      result.append('(a[' + aIndex + '] * a[' + (i - aIndex) + '])');
      if (j < half - 1) result.append(' + ');
    }
    if (jDiff > 1) result.append(')');
    if (jDiff % 2 === 1) {
      const aIndex = Math.trunc(i / 2);
      if (jDiff > 1) result.append(' + ');
      result.append('(a[' + aIndex + '] * a[' + aIndex + '])');
    }
    result.append(';\n');
  }
  result.appendLine();
  result.appendIndent();
  result.append('carryReduce(r, ');
  carryReduceArgs(result, 2 * numLimbs - 1, i => 'c' + i);
  result.append(');\n');
  result.decrIndent();
  result.appendLine('}');

  result.decrIndent();
  result.appendLine('}');
  return result.buffer;
}

function main(args) {
  const packageName = 'sun.security.util.math.intpoly';
  const header = splitLines(fs.readFileSync(args[0], 'utf8')).map(s => s + '\n').join('');
  const destPath = path.join(args[1], ...packageName.split('.'));
  fs.mkdirSync(destPath, { recursive: true });
  for (const p of ALL_FIELDS) {
    process.stdout.write(p.className + LNSEP
      + '[' + p.terms.map(t => '2^' + t.power + ' * ' + t.coefficient).join(', ') + ']' + LNSEP + LNSEP);
    fs.writeFileSync(path.join(destPath, p.className + '.java'),
      generate(p, header, packageName, 'IntegerPolynomial') + LNSEP);
  }
  return 0;
}

module.exports = { main, buildTerms };
