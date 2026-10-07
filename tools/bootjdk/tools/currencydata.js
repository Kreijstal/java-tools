'use strict';
// Port of make/jdk/src/classes/build/tools/generatecurrencydata/
// GenerateCurrencyData.java: CurrencyData.properties -> java/util/currency.data.
//
// usage: GenerateCurrencyData -o <output> [-i <input>]
const fs = require('fs');
const { DataOutput, loadProperties } = require('./misc-java');

const MAGIC_NUMBER = 0x43757244;
const A_TO_Z = 26;
const INVALID_COUNTRY_ENTRY = 0x7F;
const COUNTRY_WITHOUT_CURRENCY_ENTRY = 0x200;
const SIMPLE_CASE_COUNTRY_MASK = 0;
const SIMPLE_CASE_COUNTRY_FINAL_CHAR_MASK = 0x1F;
const SIMPLE_CASE_COUNTRY_DEFAULT_DIGITS_SHIFT = 5;
const SIMPLE_CASE_COUNTRY_MAX_DEFAULT_DIGITS = 9;
const SPECIAL_CASE_COUNTRY_MASK = 0x200;
const SPECIAL_CASE_COUNTRY_INDEX_DELTA = 1;
const NUMERIC_CODE_SHIFT = 10;
const MAX_SPECIAL_CASES = 30;
const MAX_OTHER_CURRENCIES = 128;
const LONG_MAX = 0x7fffffffffffffffn;

function parseInt32(s) {
  if (!/^[+-]?[0-9]+$/.test(s)) throw new Error('For input string: "' + s + '"');
  return parseInt(s, 10);
}

// SimpleDateFormat("yyyy-MM-dd-HH-mm-ss", Locale.US), GMT, non-lenient
function parseCutOver(s) {
  const m = /^(\d+)-(\d+)-(\d+)-(\d+)-(\d+)-(\d+)/.exec(s);
  if (!m) throw new Error('Unparseable date: "' + s + '"');
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  const dt = new Date(t);
  if (y < 100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d
      || h > 23 || mi > 59 || se > 59) {
    throw new Error('Unparseable date: "' + s + '"');
  }
  return BigInt(t);
}

function generate(props) {
  const get = k => props.has(k) ? props.get(k) : null;
  const formatVersion = get('formatVersion');
  const dataVersion = get('dataVersion');
  const valid = get('all');
  const minor = [];
  for (let i = 0; i <= SIMPLE_CASE_COUNTRY_MAX_DEFAULT_DIGITS; i++) minor.push(get('minor' + i));
  const minorUndefined = get('minorUndefined');
  if (formatVersion === null || dataVersion === null || valid === null || minorUndefined === null) {
    throw new Error('not all required data is defined in input');
  }

  function checkCurrencyCode(code) {
    if (code.length !== 3) throw new Error('illegal length for currency code: ' + code);
    for (let i = 0; i < 3; i++) {
      const c = code[i];
      if ((c < 'A' || c > 'Z') && code !== 'XB5') {
        throw new Error('currency code contains illegal character: ' + code);
      }
    }
    if (valid.indexOf(code) === -1) throw new Error('currency code not listed as valid: ' + code);
  }
  function getDefaultFractionDigits(code) {
    for (let i = 0; i <= SIMPLE_CASE_COUNTRY_MAX_DEFAULT_DIGITS; i++) {
      if (minor[i] !== null && minor[i].indexOf(code) !== -1) return i;
    }
    return minorUndefined.indexOf(code) !== -1 ? -1 : 2;
  }
  function getNumericCode(code) {
    const index = valid.indexOf(code);
    return parseInt32(valid.substring(index + 3, index + 6));
  }

  const special = [];
  const specialCaseMap = new Map();
  function makeSpecialCaseEntry(info) {
    if (specialCaseMap.has(info)) return specialCaseMap.get(info);
    if (special.length === MAX_SPECIAL_CASES) throw new Error('too many special cases');
    let e;
    if (info.length === 3) {
      checkCurrencyCode(info);
      e = { cutOver: LONG_MAX, old: info, oldDigits: getDefaultFractionDigits(info), oldNum: getNumericCode(info),
        neu: null, newDigits: 0, newNum: 0 };
    } else {
      const length = info.length;
      if (info[3] !== ';' || info[length - 4] !== ';') throw new Error('invalid currency info: ' + info);
      const oldCurrency = info.substring(0, 3);
      const newCurrency = info.substring(length - 3, length);
      checkCurrencyCode(oldCurrency);
      checkCurrencyCode(newCurrency);
      e = { cutOver: parseCutOver(info.substring(4, length - 4)),
        old: oldCurrency, oldDigits: getDefaultFractionDigits(oldCurrency), oldNum: getNumericCode(oldCurrency),
        neu: newCurrency, newDigits: getDefaultFractionDigits(newCurrency), newNum: getNumericCode(newCurrency) };
    }
    specialCaseMap.set(info, special.length);
    special.push(e);
    return special.length - 1;
  }

  const mainTable = new Array(A_TO_Z * A_TO_Z).fill(0);
  for (let first = 0; first < A_TO_Z; first++) {
    for (let second = 0; second < A_TO_Z; second++) {
      const firstChar = String.fromCharCode(65 + first);
      const secondChar = String.fromCharCode(65 + second);
      const info = get(firstChar + secondChar);
      let entry;
      if (info === null) {
        entry = INVALID_COUNTRY_ENTRY;
      } else if (info.length === 0) {
        entry = COUNTRY_WITHOUT_CURRENCY_ENTRY;
      } else if (info.length === 3 && info[0] === firstChar && info[1] === secondChar) {
        checkCurrencyCode(info);
        const digits = getDefaultFractionDigits(info);
        if (digits < 0 || digits > SIMPLE_CASE_COUNTRY_MAX_DEFAULT_DIGITS) {
          throw new Error('fraction digits out of range for ' + info);
        }
        const numericCode = getNumericCode(info);
        if (numericCode < 0 || numericCode >= 1000) throw new Error('numeric code out of range for ' + info);
        entry = SIMPLE_CASE_COUNTRY_MASK | (info.charCodeAt(2) - 65)
          | (digits << SIMPLE_CASE_COUNTRY_DEFAULT_DIGITS_SHIFT) | (numericCode << NUMERIC_CODE_SHIFT);
      } else {
        entry = SPECIAL_CASE_COUNTRY_MASK | (makeSpecialCaseEntry(info) + SPECIAL_CASE_COUNTRY_INDEX_DELTA);
      }
      mainTable[first * A_TO_Z + second] = entry;
    }
  }

  // other currencies
  if (valid.length % 7 !== 6) throw new Error('"all" entry has incorrect size');
  const others = [];
  for (let i = 0; i < Math.trunc((valid.length + 1) / 7); i++) {
    if (i > 0 && valid[i * 7 - 1] !== '-') throw new Error('incorrect separator in "all" entry');
    const code = valid.substring(i * 7, i * 7 + 3);
    parseInt32(valid.substring(i * 7 + 3, i * 7 + 6));
    checkCurrencyCode(code);
    const entry = mainTable[(code.charCodeAt(0) - 65) * A_TO_Z + (code.charCodeAt(1) - 65)];
    // a future currency must not leak into Currency.getAvailableCurrencies
    const futureCurrency = special.some(e => e.neu === code);
    const simpleCurrency = (entry & SIMPLE_CASE_COUNTRY_FINAL_CHAR_MASK) === code.charCodeAt(2) - 65;
    if (!futureCurrency && !simpleCurrency) {
      if (others.length === MAX_OTHER_CURRENCIES) throw new Error('too many other currencies');
      others.push({ code, digits: getDefaultFractionDigits(code), num: getNumericCode(code) });
    }
  }

  const out = new DataOutput();
  out.writeInt(MAGIC_NUMBER);
  out.writeInt(parseInt32(formatVersion));
  out.writeInt(parseInt32(dataVersion));
  for (const v of mainTable) out.writeInt(v);
  out.writeInt(special.length);
  for (const e of special) {
    out.writeLong(e.cutOver);
    out.writeUTF(e.old !== null ? e.old : '');
    out.writeUTF(e.neu !== null ? e.neu : '');
    out.writeInt(e.oldDigits);
    out.writeInt(e.newDigits);
    out.writeInt(e.oldNum);
    out.writeInt(e.newNum);
  }
  out.writeInt(others.length);
  for (const o of others) {
    out.writeUTF(o.code);
    out.writeInt(o.digits);
    out.writeInt(o.num);
  }
  return out.toBuffer();
}

function main(args) {
  let output = null, input = 0; // fd 0 = System.in
  for (let n = 0; n < args.length; ++n) {
    if (args[n] === '-o' || args[n] === '-i') {
      if (++n >= args.length) {
        process.stderr.write('Error: Invalid argument format\n');
        return 1;
      }
      if (args[n - 1] === '-o') output = args[n];
      else input = args[n];
    } else {
      process.stderr.write('Error: Invalid argument ' + args[n] + '\n');
      return 1;
    }
  }
  if (output === null) {
    process.stderr.write('Error: Invalid argument format\n');
    return 1;
  }
  try {
    const data = generate(loadProperties(fs.readFileSync(input).toString('latin1')));
    fs.writeFileSync(output, data);
  } catch (e) {
    process.stderr.write('Error: ' + e.message + '\n' + (e.stack || '') + '\n');
    return 1;
  }
  return 0;
}

module.exports = { main, generate };
