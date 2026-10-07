'use strict';
// Port of make/jdk/src/classes/build/tools/generatecharacter/
// GenerateCharacter.java (with UnicodeSpec, SpecialCaseMap, PropList,
// EmojiData and Utility.formatForSource): generates the
// java.lang.CharacterData* classes from the UCD files and a template.
//
// Property values are Java longs below 2^44; they are held as Numbers
// (hi * 2^32 + lo), and as BigInt where the Java code does long arithmetic.
//
// usage: GenerateCharacter [-string] [-plane n | -latin1] [-d] -template f
//   -spec f -specialcasing f -proplist f -derivedprops f -emojidata f -o f
//   [-usecharforbyte] sizes...
const fs = require('fs');
const { LNSEP } = require('./util');
const { readLines, isBlank } = require('./genchar-common');

const TWO32 = 4294967296;
const hiOf = v => Math.floor(v / TWO32);
const loOf = v => v % TWO32;

// GenerateCharacter constants
const shiftType = 0, maskType = 0x001F,
  shiftDigitOffset = 5, maskDigitOffset = 0x03E0,
  shiftNumericType = 10, maskNumericType = 0x0C00,
  shiftIdentifierInfo = 12, maskIdentifierInfo = 0x7000,
  maskUnicodePart = 0x1000,
  maskLowerCase = 0x20000, maskUpperCase = 0x10000, maskTitleCase = 0x08000,
  shiftCaseOffset = 18, maskCaseOffset = 0x07FC0000, shiftCaseOffsetSign = 5,
  maskDigit = 0x001F, maskCase = 0x01FF,
  shiftBidi = 27, maskBidi = 0x78000000;
const maskMirrored = 0x80000000;
// bits of the high word (B table): mask = 1L << (32 + bit)
const HI = {
  maskOtherLowercase: 0, maskOtherUppercase: 1, maskOtherAlphabetic: 2,
  maskIdeographic: 3, maskIDStart: 4, maskIDContinue: 5, maskEmoji: 6,
  maskEmojiPresentation: 7, maskEmojiModifier: 8, maskEmojiModifierBase: 9,
  maskEmojiComponent: 10, maskExtendedPictographic: 11,
};
const valueNotNumeric = 0x0000, valueDigit = 0x0400, valueStrangeNumeric = 0x0800,
  valueJavaSupradecimal = 0x0C00, valueIgnorable = 0x1000, valueJavaOnlyPart = 0x2000,
  valueJavaUnicodePart = 0x3000, valueJavaWhitespace = 0x4000,
  valueJavaStartUnicodePart = 0x5000, valueJavaOnlyStart = 0x6000,
  valueJavaUnicodeStart = 0x7000, lowJavaStart = 0x5000, nonzeroJavaPart = 0x3000,
  valueUnicodeStart = 0x7000;
const bitJavaStart = 0x02, bitJavaPart = 0x01;
const maxOffset = maskCase >> 1, minOffset = -maxOffset;

// UnicodeSpec
const GC = [
  ['Cn', 'UNASSIGNED'], ['Lu', 'UPPERCASE_LETTER'], ['Ll', 'LOWERCASE_LETTER'],
  ['Lt', 'TITLECASE_LETTER'], ['Lm', 'MODIFIER_LETTER'], ['Lo', 'OTHER_LETTER'],
  ['Mn', 'NON_SPACING_MARK'], ['Me', 'ENCLOSING_MARK'], ['Mc', 'COMBINING_SPACING_MARK'],
  ['Nd', 'DECIMAL_DIGIT_NUMBER'], ['Nl', 'LETTER_NUMBER'], ['No', 'OTHER_NUMBER'],
  ['Zs', 'SPACE_SEPARATOR'], ['Zl', 'LINE_SEPARATOR'], ['Zp', 'PARAGRAPH_SEPARATOR'],
  ['Cc', 'CONTROL'], ['Cf', 'FORMAT'], ['xx', 'unused'], ['Co', 'PRIVATE_USE'],
  ['Cs', 'SURROGATE'], ['Pd', 'DASH_PUNCTUATION'], ['Ps', 'START_PUNCTUATION'],
  ['Pe', 'END_PUNCTUATION'], ['Pc', 'CONNECTOR_PUNCTUATION'], ['Po', 'OTHER_PUNCTUATION'],
  ['Sm', 'MATH_SYMBOL'], ['Sc', 'CURRENCY_SYMBOL'], ['Sk', 'MODIFIER_SYMBOL'],
  ['So', 'OTHER_SYMBOL'], ['Pi', 'INITIAL_QUOTE_PUNCTUATION'], ['Pf', 'FINAL_QUOTE_PUNCTUATION'],
];
const G = Object.fromEntries(GC.map((g, i) => [g[1], i]));
const BIDI = [
  ['L', 'DIRECTIONALITY_LEFT_TO_RIGHT'], ['R', 'DIRECTIONALITY_RIGHT_TO_LEFT'],
  ['AL', 'DIRECTIONALITY_RIGHT_TO_LEFT_ARABIC'], ['EN', 'DIRECTIONALITY_EUROPEAN_NUMBER'],
  ['ES', 'DIRECTIONALITY_EUROPEAN_NUMBER_SEPARATOR'], ['ET', 'DIRECTIONALITY_EUROPEAN_NUMBER_TERMINATOR'],
  ['AN', 'DIRECTIONALITY_ARABIC_NUMBER'], ['CS', 'DIRECTIONALITY_COMMON_NUMBER_SEPARATOR'],
  ['NSM', 'DIRECTIONALITY_NONSPACING_MARK'], ['BN', 'DIRECTIONALITY_BOUNDARY_NEUTRAL'],
  ['B', 'DIRECTIONALITY_PARAGRAPH_SEPARATOR'], ['S', 'DIRECTIONALITY_SEGMENT_SEPARATOR'],
  ['WS', 'DIRECTIONALITY_WHITESPACE'], ['ON', 'DIRECTIONALITY_OTHER_NEUTRALS'],
  ['LRE', 'DIRECTIONALITY_LEFT_TO_RIGHT_EMBEDDING'], ['LRO', 'DIRECTIONALITY_LEFT_TO_RIGHT_OVERRIDE'],
  ['RLE', 'DIRECTIONALITY_RIGHT_TO_LEFT_EMBEDDING'], ['RLO', 'DIRECTIONALITY_RIGHT_TO_LEFT_OVERRIDE'],
  ['PDF', 'DIRECTIONALITY_POP_DIRECTIONAL_FORMAT'], ['LRI', 'DIRECTIONALITY_LEFT_TO_RIGHT_ISOLATE'],
  ['RLI', 'DIRECTIONALITY_RIGHT_TO_LEFT_ISOLATE'], ['FSI', 'DIRECTIONALITY_FIRST_STRONG_ISOLATE'],
  ['PDI', 'DIRECTIONALITY_POP_DIRECTIONAL_ISOLATE'],
];
const DIRECTIONALITY_OTHER_NEUTRALS = 13;
const MAP_UNDEFINED = -1;

class JavaNFE extends Error {}

// Integer.parseInt(s, radix)
function parseInt32(s, radix) {
  const re = radix === 16 ? /^[+-]?[0-9a-fA-F]+$/ : /^[+-]?[0-9]+$/;
  if (!re.test(s)) throw new JavaNFE(`For input string: "${s}"`);
  const v = parseInt(s, radix);
  if (v > 0x7fffffff || v < -0x80000000) throw new JavaNFE(`For input string: "${s}"`);
  return v;
}

function newSpec(codePoint = 0xffff) {
  return {
    codePoint, name: null, generalCategory: G.UNASSIGNED, bidiCategory: -1, mirrored: false,
    oldName: null, titleMap: MAP_UNDEFINED, upperMap: MAP_UNDEFINED, lowerMap: MAP_UNDEFINED,
    decimalValue: -1, digitValue: -1, numericValue: '',
  };
}

function parseMap(s) {
  if (s.length >= 4 && s.length <= 6) return parseInt32(s, 16);
  if (s.length !== 0) throw new JavaNFE('');
  return MAP_UNDEFINED;
}

function parseSpec(s) {
  try {
    // Pattern.split(s, 15)
    const all = s.split(';');
    const t = all.length > 15 ? all.slice(0, 14).concat(all.slice(14).join(';')) : all;
    const spec = newSpec();
    spec.codePoint = parseInt32(t[0], 16);
    if (t[1] == null) throw new Error();
    spec.name = t[1];
    spec.generalCategory = GC.findIndex(g => g[0] === t[2]);
    if (spec.generalCategory < 0) throw new Error();
    if (t[3] == null) throw new Error();
    if (t[3].length > 0) parseInt32(t[3], 10);
    spec.bidiCategory = BIDI.findIndex(b => b[0] === t[4]);
    if (spec.bidiCategory < 0) throw new Error();
    if (t[5] == null) throw new Error();
    spec.decimalValue = t[6].length > 0 ? parseInt32(t[6], 10) : -1;
    spec.digitValue = t[7].length > 0 ? parseInt32(t[7], 10) : -1;
    if (t[8] == null) throw new Error();
    spec.numericValue = t[8];
    if (t[9] === 'Y') spec.mirrored = true;
    else if (t[9] === 'N') spec.mirrored = false;
    else throw new Error();
    if (t[10] == null || t[11] == null) throw new Error();
    spec.oldName = t[10];
    spec.upperMap = parseMap(t[12]);
    spec.lowerMap = parseMap(t[13]);
    spec.titleMap = parseMap(t[14]);
    return spec;
  } catch (e) {
    process.stdout.write('Error parsing spec line.' + LNSEP);
    return null;
  }
}

// String.trim()
const trim = s => s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');

function readUnicodeSpec(file, plane) {
  const list = [];
  for (const line of readLines(file)) {
    const item = parseSpec(trim(line));
    if (item === null) throw new TypeError('NullPointerException');
    const specPlane = item.codePoint >>> 16;
    if (specPlane < plane) continue;
    if (specPlane > plane) break;
    list.push(item);
  }
  return list;
}

// SpecialCaseMap
const isSpaceChar = c => c === 0x20 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;

function parseCaseMap(token) {
  let pos = 0;
  const buff = [];
  while (pos < token.length) {
    while (isSpaceChar(token.charCodeAt(pos++)));
    --pos;
    const start = pos;
    while (pos < token.length && !isSpaceChar(token.charCodeAt(pos))) pos++;
    const ch = parseInt32(token.substring(start, pos), 16);
    if (ch > 0xffff) {
      buff.push(Math.floor((ch - 0x10000) / 0x400) + 0xd800, (ch - 0x10000) % 0x400 + 0xdc00);
    } else buff.push(ch & 0xffff);
  }
  return buff;
}

function parseSpecialCase(s) {
  if (s.length === 0 || s[0] === '#') return null;
  try {
    const tokens = [];
    let tokenStart = 0, x;
    for (x = 0; x < 4; x++) {
      const tokenEnd = s.indexOf(';', tokenStart);
      if (tokenEnd < 0) throw new Error();
      tokens[x] = s.substring(tokenStart, tokenEnd);
      tokenStart = tokenEnd + 1;
    }
    tokens[x] = s.substring(tokenStart);
    if (tokens[4].indexOf(';') !== -1) return null;
    return {
      chSource: parseInt32(tokens[0], 16),
      upperCaseMap: parseCaseMap(tokens[3]),
      lowerCaseMap: parseCaseMap(tokens[1]),
      titleCaseMap: parseCaseMap(tokens[2]),
    };
  } catch (e) {
    process.stdout.write('Error parsing spec line.' + LNSEP);
    return null;
  }
}

function readSpecialCasing(file, plane) {
  const maps = [];
  for (const line of readLines(file)) {
    const item = parseSpecialCase(trim(line));
    if (item === null) continue;
    if (item.chSource >> 16 < plane) continue;
    if (item.chSource >> 16 > plane) break;
    maps.push(item);
  }
  return maps.sort((a, b) => a.chSource - b.chSource);
}

function findSpecial(ch, map) {
  if (map.length === 0) return -1;
  let bottom = 0, top = map.length, current = top >> 1;
  while (top - bottom > 1) {
    if (ch >= map[current].chSource) bottom = current;
    else top = current;
    current = (top + bottom) >> 1;
  }
  return ch === map[current].chSource ? current : -1;
}

// PropList
function readPropList(file, plane, propMap) {
  const re = /^([0-9A-Fa-f]+)(?:\.{2}([0-9A-Fa-f]+))?[ \t\n\x0b\f\r]*;[ \t\n\x0b\f\r]+(\w+)[; \t\n\x0b\f\r].*$/;
  const local = new Map();
  let lineNo = 0;
  for (const line of readLines(file)) {
    lineNo++;
    if (line.length <= 1 || line[0] === '#') continue;
    const m = re.exec(line);
    if (m) {
      let start = parseInt(m[1], 16);
      if ((start >> 16) !== plane) continue;
      let end = m[2] === undefined ? start : parseInt(m[2], 16);
      start &= 0xffff;
      end &= 0xffff;
      let list = local.get(m[3]);
      if (!list) local.set(m[3], list = []);
      while (start <= end) list.push(start++);
    } else {
      process.stdout.write(`Warning: Unrecognized line ${lineNo} <${line}>${LNSEP}`);
    }
  }
  for (const [k, v] of local) propMap.set(k, v);
}

// EmojiData: code point -> high word bits
function readEmojiData(file, plane) {
  const props = new Map();
  const bit = {
    Emoji: HI.maskEmoji, Emoji_Presentation: HI.maskEmojiPresentation,
    Emoji_Modifier: HI.maskEmojiModifier, Emoji_Modifier_Base: HI.maskEmojiModifierBase,
    Emoji_Component: HI.maskEmojiComponent, Extended_Pictographic: HI.maskExtendedPictographic,
  };
  for (let line of readLines(file)) {
    const h = line.indexOf('#');
    if (h >= 0) line = line.slice(0, h);
    if (isBlank(line)) continue;
    const m = /[ \t]*;[ \t]*/.exec(line);
    const map = m ? [line.slice(0, m.index), line.slice(m.index + m[0].length)] : [line];
    const dd = map[0].indexOf('..');
    const range = dd >= 0 ? [map[0].slice(0, dd), map[0].slice(dd + 2)] : [map[0]];
    const start = parseInt32(range[0], 16);
    if ((start >> 16) !== plane) continue;
    const type = trim(map[1]);
    if (!(type in bit)) throw new Error('Unrecognizable Emoji type: ' + type);
    const end = range.length === 1 ? start : parseInt32(range[1], 16);
    for (let cp = start; cp <= end; cp++) props.set(cp, (props.get(cp) || 0) | (1 << bit[type]));
  }
  return props;
}

// Utility.formatForSource
function formatForSource(s, indent) {
  const H = '0123456789ABCDEF';
  const buf = [];
  let len = 0;
  for (let i = 0; i < s.length;) {
    if (i > 0) { buf.push('+\n'); len += 2; }
    const limit = len + 78;
    buf.push(indent + '"'); len += indent.length + 1;
    while (i < s.length && len < limit) {
      const c = s.charCodeAt(i++);
      let e;
      if (c <= 0o377) e = '\\' + H[(c & 0o700) >> 6] + H[(c & 0o070) >> 3] + H[c & 0o007];
      else e = '\\u' + H[(c & 0xF000) >> 12] + H[(c & 0x0F00) >> 8] + H[(c & 0x00F0) >> 4] + H[c & 0x000F];
      buf.push(e); len += e.length;
    }
    buf.push('"'); len++;
  }
  return buf.join('');
}

// Long.toHexString of a BigInt holding a Java long
const lhex = n => BigInt.asUintN(64, BigInt(n)).toString(16).toUpperCase();
const hex = n => lhex(n);
const padHex = (n, w) => {
  const q = BigInt.asUintN(w * 4, BigInt(n)).toString(16).toUpperCase();
  return '0'.repeat(Math.max(0, w - q.length)) + q;
};
const hex2 = n => padHex(n, 2), hex4 = n => padHex(n, 4), hex8 = n => padHex(n, 8);
const hex16 = n => { const q = lhex(n); return '0'.repeat(Math.max(0, 16 - q.length)) + q; };
const decN = (n, w) => { const q = String(n); return ' '.repeat(Math.max(0, w - q.length)) + q; };
const dec3 = n => decN(n, 3), dec5 = n => decN(n, 5);

// Character.isJavaIdentifierStart
const isJavaIdentifierStart = ch => /[\p{L}\p{Nl}\p{Sc}\p{Pc}]/u.test(ch);

class Generator {
  constructor() {
    this.verbose = false; this.debug = false; this.nobidi = false; this.nomirror = false;
    this.identifiers = false; this.Csyntax = false; this.useCharForByte = false;
    this.tableAsString = false; this.bLatin1 = false; this.plane = 0;
    this.sizes = null; this.initializers = '';
    this.files = {};
  }

  FAIL(s) { process.stdout.write('** ' + s + LNSEP); }

  processArgs(args) {
    let desc = 'java GenerateCharacter';
    for (const a of args) desc += ' ' + a;
    const f = this.files;
    const fileOpt = { '-o': 'out', '-template': 'template', '-spec': 'spec',
      '-specialcasing': 'specialcasing', '-proplist': 'proplist',
      '-derivedprops': 'derivedprops', '-emojidata': 'emojidata' };
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (a === '-verbose' || a === '-v') this.verbose = true;
      else if (a === '-d') this.debug = true;
      else if (a === '-nobidi') this.nobidi = true;
      else if (a === '-nomirror') this.nomirror = true;
      else if (a === '-identifiers') this.identifiers = true;
      else if (a === '-c') this.Csyntax = true;
      else if (a === '-string') this.tableAsString = true;
      else if (a in fileOpt) {
        if (j === args.length - 1) this.FAIL(`File name missing after ${a}`);
        else f[fileOpt[a]] = args[++j];
      } else if (a === '-search') {
        throw new Error('GenerateCharacter: -search is not supported by this port');
      } else if (a === '-plane') {
        if (j === args.length - 1) this.FAIL('Plane number missing after -plane');
        else this.plane = parseInt32(args[++j], 10);
        if (this.plane > 0) this.bLatin1 = false;
      } else if (a === '-usecharforbyte') this.useCharForByte = true;
      else if (a === '-latin1') { this.bLatin1 = true; this.plane = 0; }
      else {
        try {
          const val = parseInt32(a, 10);
          if (val < 0 || val > 32) this.FAIL('Incorrect bit field width: ' + a);
          (this.sizes = this.sizes || []).push(val);
        } catch (e) {
          if (!(e instanceof JavaNFE)) throw e;
          this.FAIL('Unknown switch: ' + a);
        }
      }
    }
    if (this.Csyntax && this.tableAsString) this.FAIL("Can't specify table as string with C syntax");
    if (this.sizes === null) {
      if (this.identifiers) { this.sizes = [8, 4, 4]; desc += ' [8 4 4]'; }
      else { this.sizes = [10, 5, 1]; desc += ' [10 5 1]'; }
    }
    const defaults = [['spec', 'UnicodeData.txt'], ['specialcasing', 'SpecialCasing.txt'],
      ['proplist', 'PropList.txt'], ['derivedprops', 'DerivedCoreProperties.txt'],
      ['emojidata', 'emoji-data.txt'],
      ['template', this.Csyntax ? 'Character.c.template' : 'Character.java.template'],
      ['out', this.Csyntax ? 'Character.c' : 'Character.java']];
    const optName = { spec: '-spec', specialcasing: '-specialcasing', proplist: '-proplist',
      derivedprops: '-derivedprops', emojidata: '-emojidata', template: '-template', out: '-o' };
    for (const [k, d] of defaults) {
      if (f[k] == null) { f[k] = d; desc += ` [${optName[k]} ${d}]`; }
    }
    this.commentStart = this.Csyntax ? '/*' : '//';
    this.commentEnd = this.Csyntax ? ' */' : '';
    this.commandLineDescription = desc.split('\\').join('\\\\');
  }

  // property bits for one character: [hi, lo]
  buildOne(c, us) {
    let lo = us.generalCategory, hi = 0;
    if (lo === G.UPPERCASE_LETTER) hi |= 1 << HI.maskOtherUppercase;
    else if (lo === G.LOWERCASE_LETTER) hi |= 1 << HI.maskOtherLowercase;

    numeric: {
      strange: {
        let val = 0;
        if (c >= 0x41 && c <= 0x5A) { val = c - 0x41; lo |= valueJavaSupradecimal; }
        else if (c >= 0x61 && c <= 0x7A) { val = c - 0x61; lo |= valueJavaSupradecimal; }
        else if (c >= 0xFF21 && c <= 0xFF3A) { val = c - 0xFF21; lo |= valueJavaSupradecimal; }
        else if (c >= 0xFF41 && c <= 0xFF5A) { val = c - 0xFF41; lo |= valueJavaSupradecimal; }
        else if (us.decimalValue !== -1) { val = us.decimalValue; lo |= valueDigit; }
        else if (us.digitValue !== -1) { val = us.digitValue; lo |= valueDigit; }
        else {
          if (us.numericValue.length === 0) break numeric;
          try {
            val = parseInt32(us.numericValue, 10);
          } catch (e) {
            break strange;
          }
          if (val >= 32 || val < 0) break strange;
          if (c === 0x215F) break strange;
          lo |= valueDigit;
        }
        if (val >= 32 || val < 0) break strange;
        lo |= ((val - c) & maskDigit) << shiftDigitOffset;
        break numeric;
      }
      lo |= valueStrangeNumeric;
    }

    let offset = 0;
    const hasUpper = us.upperMap !== MAP_UNDEFINED;
    const hasLower = us.lowerMap !== MAP_UNDEFINED;
    const hasTitle = us.titleMap !== MAP_UNDEFINED;
    const specialMap = findSpecial(c, this.specialCaseMaps);
    const bHasUpper = hasUpper || specialMap !== -1;
    if (bHasUpper) lo |= maskUpperCase;
    if (specialMap !== -1) offset = -1;
    else if (hasUpper) offset = c - us.upperMap;
    if (hasLower) {
      lo |= maskLowerCase;
      if (offset === 0) offset = us.lowerMap - c;
    }
    if ((hasTitle && us.titleMap !== us.upperMap) || (bHasUpper && hasLower)) lo |= maskTitleCase;
    if (bHasUpper && !hasLower && !hasTitle && this.verbose) {
      process.stdout.write(`Warning: Character ${hex4(c)} has upper but no title case; Java won't know this${LNSEP}`);
    }
    if (offset > maxOffset || offset < minOffset) offset = maskCase;
    lo |= (offset & maskCase) << shiftCaseOffset;

    const gc = us.generalCategory;
    if (gc === G.LOWERCASE_LETTER || gc === G.UPPERCASE_LETTER || gc === G.TITLECASE_LETTER ||
        gc === G.MODIFIER_LETTER || gc === G.OTHER_LETTER || gc === G.LETTER_NUMBER) {
      lo |= valueJavaUnicodeStart;
    } else if (gc === G.COMBINING_SPACING_MARK || gc === G.NON_SPACING_MARK || gc === G.DECIMAL_DIGIT_NUMBER) {
      lo |= valueJavaUnicodePart;
    } else if (gc === G.CONNECTOR_PUNCTUATION) {
      lo |= valueJavaStartUnicodePart;
    } else if (gc === G.CURRENCY_SYMBOL) {
      lo |= valueJavaOnlyStart;
    } else if ((c >= 0 && c <= 8) || (c >= 0x0E && c <= 0x1B) || (c >= 0x7F && c <= 0x9F) || gc === G.FORMAT) {
      lo |= valueIgnorable;
    } else if (gc === G.SPACE_SEPARATOR || gc === G.LINE_SEPARATOR || gc === G.PARAGRAPH_SEPARATOR) {
      if (![0x00A0, 0x2007, 0x202F, 0xFEFF].includes(c)) lo |= valueJavaWhitespace;
    } else if ((c >= 0x09 && c <= 0x0D) || (c >= 0x1C && c <= 0x1F)) {
      lo |= valueJavaWhitespace;
    }

    if (!this.nobidi) {
      lo |= (us.bidiCategory > DIRECTIONALITY_OTHER_NEUTRALS || us.bidiCategory === -1)
        ? maskBidi : us.bidiCategory << shiftBidi;
    }
    if (!this.nomirror && us.mirrored) lo |= maskMirrored;
    lo >>>= 0;

    if (this.identifiers) {
      let r = 0;
      if ((lo & maskIdentifierInfo) >= lowJavaStart) r |= bitJavaStart;
      if ((lo & nonzeroJavaPart) !== 0 && (lo & maskIdentifierInfo) !== valueIgnorable) r |= bitJavaPart;
      return r;
    }
    return hi * TWO32 + lo;
  }

  buildMap(data, propMap, emoji) {
    const result = new Array(this.bLatin1 ? 256 : 1 << 16);
    const plane = this.plane;
    let k = 0, codePoint = plane << 16;
    const nonCharSpec = newSpec();
    for (let j = 0; j < data.length && k < result.length; j++) {
      const d = data[j];
      if (d.codePoint === codePoint) {
        result[k++] = this.buildOne(codePoint++, d);
      } else if (d.codePoint > codePoint) {
        const fill = d.name.endsWith('Last>') ? d : nonCharSpec;
        while (codePoint < d.codePoint && k < result.length) result[k++] = this.buildOne(codePoint++, fill);
        k = d.codePoint & 0xffff;
        codePoint = d.codePoint;
        if (k >= result.length) throw new RangeError(`Index ${k} out of bounds for length ${result.length}`);
        result[k++] = this.buildOne(codePoint++, d);
      } else {
        process.stdout.write('An error has occurred during spec mapping.' + LNSEP);
        process.exit(0);
      }
    }
    codePoint = (plane << 16) | k;
    while (k < result.length) result[k++] = this.buildOne(codePoint++, nonCharSpec);

    const addHi = (i, bit) => {
      const v = result[i];
      const h = hiOf(v);
      if (!(h & (1 << bit))) result[i] = (h | (1 << bit)) * TWO32 + loOf(v);
    };
    for (const [prop, bit] of [['Other_Lowercase', HI.maskOtherLowercase],
      ['Other_Uppercase', HI.maskOtherUppercase], ['Other_Alphabetic', HI.maskOtherAlphabetic],
      ['Ideographic', HI.maskIdeographic], ['ID_Start', HI.maskIDStart], ['ID_Continue', HI.maskIDContinue]]) {
      const cps = propMap.get(prop);
      if (cps) for (const cp of cps) if (cp < result.length) addHi(cp, bit);
    }
    for (const [cp, bits] of emoji) {
      const index = cp & 0xffff;
      if (index < result.length) {
        for (let b = 0; b < 12; b++) if (bits & (1 << b)) addHi(index, b);
      }
    }
    return result;
  }

  // compressed table: blocks of 1<<size identical entries are shared
  buildTable(map, size) {
    const n = map.length;
    if (((n >> size) << size) !== n) this.FAIL(`Length ${n} is not a multiple of ${1 << size}`);
    const m = 1 << size;
    const newmap = new Array(n >> size);
    const buffer = [];
    const seen = new Map();
    for (let i = 0; i < n; i += m) {
      const key = map.slice(i, i + m).join(',');
      const j = seen.get(key);
      if (j !== undefined) { newmap[i >> size] = j >> size; continue; }
      const ptr = buffer.length;
      for (let k = 0; k < m; k++) buffer.push(map[i + k]);
      seen.set(key, ptr);
      newmap[i >> size] = ptr >> size;
    }
    return [newmap, buffer];
  }

  generateCharacterClass(templateFile, outputFile) {
    const out = [this.commentStart + ' This file was generated AUTOMATICALLY from a template file ' + this.commentEnd];
    for (let line of readLines(templateFile)) {
      let pos = 0, depth = 0;
      while ((pos = line.indexOf('$$', pos)) >= 0) {
        let newpos = pos + 2;
        let ch;
        while (newpos < line.length &&
               (isJavaIdentifierStart(ch = line[newpos]) || ch === '(' || (ch === ')' && depth > 0))) {
          ++newpos;
          if (ch === '(') ++depth;
          else if (ch === ')') {
            --depth;
            if (depth === 0) break;
          }
        }
        const replacement = this.replaceCommand(line.substring(pos + 2, newpos));
        line = line.substring(0, pos) + replacement + line.substring(newpos);
        pos += replacement.length;
      }
      out.push(line);
    }
    fs.writeFileSync(outputFile, out.map(l => l + LNSEP).join(''));
  }

  replaceCommand(x) {
    if (x === 'Tables') return this.genTables();
    if (x === 'Initializers') return this.initializers;
    if (x.length >= 9 && x.startsWith('Lookup(') && x.endsWith(')')) {
      return this.genAccess('A', x.substring(7, x.length - 1), this.identifiers ? 2 : 32);
    }
    if (x.length >= 11 && x.startsWith('LookupEx(') && x.endsWith(')')) {
      return this.genAccess('B', x.substring(9, x.length - 1), 16);
    }
    const dec = { shiftType, shiftIdentifierInfo, shiftCaseOffset, shiftCaseOffsetSign,
      bitJavaPart, shiftDigitOffset, shiftNumericType, shiftBidi };
    if (x in dec) return String(dec[x]);
    const h8 = { maskIdentifierInfo, maskUnicodePart, maskCase, maskCaseOffset, maskLowerCase,
      maskUpperCase, maskTitleCase, valueIgnorable, valueJavaUnicodeStart, valueJavaOnlyStart,
      valueJavaUnicodePart, valueJavaOnlyPart, valueJavaWhitespace, lowJavaStart, nonzeroJavaPart,
      bitJavaStart, valueUnicodeStart, valueNotNumeric, valueDigit, valueStrangeNumeric,
      valueJavaSupradecimal, maskMirrored };
    if (x in h8) return '0x' + hex8(h8[x]);
    if (x in HI) return '0x' + hex4(1 << HI[x]);
    const h = { maskIsJavaIdentifierStart: bitJavaStart, maskIsJavaIdentifierPart: bitJavaPart,
      maskDigitOffset, maskDigit, maskNumericType, maskType, maskBidi };
    if (x in h) return '0x' + hex(h[x]);
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 29, 30, 23, 24, 10, 25, 26, 27, 28];
    for (const i of order) if (x === GC[i][1]) return String(i);
    const border = [0, 14, 15, 1, 2, 16, 17, 18, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 19, 20, 21, 22];
    for (const i of border) if (x === BIDI[i][1]) return String(i);
    this.FAIL('Unknown text substitution marker $$' + x);
    return '$$' + x;
  }

  genTables() {
    const n = this.sizes.length;
    let result = '';
    if (this.debug) {
      result += this.commentStart + ' The following tables and code generated using:' + this.commentEnd + '\n  ' +
        this.commentStart + ' ' + this.commandLineDescription + this.commentEnd + '\n  ';
    }
    if (this.plane === 0 && !this.bLatin1) {
      result += '    @Stable static final char[][][] charMap;\n';
      this.genCaseMapTable();
    }
    let totalBytes = 0;
    for (let k = 0; k < n - 1; k++) {
      result += this.genTable(this.tableNames[k], this.tables[k], 0, this.bytes[k] << 3, this.sizes[k],
        this.preshifted[k], this.sizes[k + 1], false, false, k === 0);
      let s = this.bytes[k];
      if (s === 1 && this.useCharForByte) s = 2;
      totalBytes += this.tables[k].length * s;
    }
    const last = this.tables[n - 1];
    result += this.genTable('A', last, 0, this.identifiers ? 2 : 32, this.sizes[n - 1], false, 0, true,
      !this.identifiers, false);
    result += this.genTable('B', last, 32, 16, this.sizes[n - 1], false, 0, true, true, false);
    totalBytes += ((((last.length * (this.identifiers ? 2 : 32)) + 31) >> 5) << 2);
    result += this.commentStart + ' In all, the character property tables require ' + totalBytes +
      ' bytes.' + this.commentEnd;
    if (this.verbose) process.stdout.write(`The character property tables require ${totalBytes} bytes.${LNSEP}`);
    return result;
  }

  addInitializer(name, type, entriesPerChar, bits, size) {
    let template = entriesPerChar === 1 ? SAME_SIZE_INITIALIZER
      : entriesPerChar > 0 ? SMALL_INITIALIZER : BIG_INITIALIZER;
    if (entriesPerChar === -2) template = INT32_INITIALIZER;
    let pos = 0;
    while ((pos = template.indexOf('$$', pos)) >= 0) {
      let newpos = pos + 2, ch;
      while (newpos < template.length && isJavaIdentifierStart(ch = template[newpos]) && ch !== '_') ++newpos;
      const token = template.substring(pos + 2, newpos);
      let replacement;
      switch (token) {
        case 'name': replacement = name; break;
        case 'type': replacement = type; break;
        case 'bits': replacement = '' + bits; break;
        case 'size': replacement = '' + size; break;
        case 'entriesPerChar': replacement = '' + entriesPerChar; break;
        case 'charsPerEntry': replacement = '' + (-entriesPerChar); break;
        default: this.FAIL('Unrecognized token: ' + token); replacement = 'ERROR';
      }
      template = template.substring(0, pos) + replacement + template.substring(newpos);
      pos += replacement.length;
    }
    this.initializers += template;
  }

  genTable(name, table, extract, bits, size, preshifted, shift, hexFormat, properties, hexComment) {
    const C = this.Csyntax;
    let atype = bits === 1 || bits === 2 || bits === 4 || bits === 32 ? (C ? 'unsigned long' : 'int')
      : bits === 8 ? (C ? 'unsigned char' : 'byte')
      : bits === 16 ? (C ? 'unsigned short' : 'char')
      : (C ? 'int64' : 'long');
    let maxPosEntry = bits === 8 ? 127n : bits === 16 ? 32767n : bits === 64 ? 0x7fffffffffffffffn : 0x7fffffffn;
    if (bits !== 1 && bits !== 2 && bits !== 4 && bits !== 8 && bits !== 16 && bits !== 32) maxPosEntry = 0x7fffffffffffffffn;
    let entriesPerChar = bits <= 16 ? Math.trunc(16 / bits) : -Math.trunc(bits / 16);
    const shiftEntries = preshifted && shift !== 0;
    if (bits === 8 && this.tableAsString && this.useCharForByte) {
      atype = 'char';
      maxPosEntry = 0xffffn;
      entriesPerChar = 1;
    }
    const noConversion = atype === 'char';
    const cs = this.commentStart, ce = this.commentEnd;
    let r = cs + ' The ' + name + ' table has ' + table.length + ' entries for a total of ';
    let sizeOfTable = ((table.length * bits + 31) >> 5) << 2;
    if (bits === 8 && this.tableAsString && this.useCharForByte) sizeOfTable *= 2;
    r += sizeOfTable + ' bytes.' + ce + '\n\n';
    r += C ? '  static ' : '  @Stable static final ';
    r += atype + ' ' + name + '[';
    if (C) r += table.length >> (bits === 1 ? 5 : bits === 2 ? 4 : bits === 4 ? 3 : 0);
    if (this.tableAsString) {
      if (noConversion) r += '] = (\n';
      else r += '] = new ' + atype + '[' + table.length + '];\n  static final String ' + name + '_DATA =\n';
      const chars = [];
      let entriesInCharSoFar = 0, ch = 0;
      const charsPerEntry = -entriesPerChar;
      for (const l of table) {
        let entry = name === 'A' ? BigInt(loOf(l)) >> BigInt(extract) : BigInt(l) >> BigInt(extract);
        if (shiftEntries) entry = BigInt.asIntN(64, entry << BigInt(shift));
        if (entry >= (1n << BigInt(bits))) this.FAIL('Entry too big');
        if (entriesPerChar > 0) {
          ch = Number(BigInt.asUintN(16, BigInt(ch >> bits) | (entry << BigInt((entriesPerChar - 1) * bits))));
          if (++entriesInCharSoFar === entriesPerChar) {
            chars.push(ch);
            entriesInCharSoFar = 0;
            ch = 0;
          }
        } else {
          for (let k = 0; k < charsPerEntry; ++k) {
            ch = Number(BigInt.asUintN(16, entry >> BigInt((charsPerEntry - 1) * 16)));
            entry = BigInt.asIntN(64, entry << 16n);
            chars.push(ch);
          }
        }
      }
      if (entriesInCharSoFar > 0) {
        while (entriesInCharSoFar < entriesPerChar) { ch >>= bits; ++entriesInCharSoFar; }
        chars.push(ch);
      }
      let s = '';
      for (let i = 0; i < chars.length; i += 8192) s += String.fromCharCode(...chars.slice(i, i + 8192));
      r += formatForSource(s, '    ');
      if (noConversion) r += ').toCharArray()';
      r += ';\n\n  ';
      if (!noConversion) this.addInitializer(name, atype, entriesPerChar, bits, table.length);
      return r;
    }

    r += '] = {';
    const castEntries = shiftEntries && bits < 32;
    const printPerLine = hexFormat
      ? (bits === 1 ? 128 : bits === 2 ? 64 : bits === 4 ? 32 : bits === 8 ? 8 : bits === 16 ? 8 : bits === 32 ? 4 : 2)
      : (bits === 8 ? 8 : bits === 16 ? 8 : 4);
    const printMask = properties ? 0
      : Math.min(1 << size, printPerLine >> (castEntries ? (C ? 2 : 1) : 0)) - 1;
    const commentShift = (1 << size) === table.length ? 0 : size;
    const commentMask = (1 << size) === table.length ? printMask : (1 << size) - 1;
    let val = 0n;
    const parts = [r];
    for (let j = 0; j < table.length; j++) {
      if ((j & printMask) === 0) {
        let last = parts[parts.length - 1];
        while (last.endsWith(' ')) last = last.slice(0, -1);
        // the trailing spaces may span earlier parts
        parts[parts.length - 1] = last;
        while (last === '' && parts.length > 1) {
          parts.pop();
          last = parts[parts.length - 1].replace(/ +$/, '');
          parts[parts.length - 1] = last;
        }
        parts.push('\n    ');
      }
      print: {
        let p = '';
        if (castEntries) p += '(' + atype + ')(';
        const entry = BigInt(table[j]) >> BigInt(extract);
        const packMask = (1 << (bits === 1 ? 5 : bits === 2 ? 4 : bits === 4 ? 3 : 2)) - 1;
        const k = j & packMask;
        if (bits >= 8) val = entry;
        else if (k === 0) { val = entry; parts.push(p); break print; }
        else {
          val = BigInt.asIntN(64, val | (entry << BigInt(k * bits)));
          if (k !== packMask) { parts.push(p); break print; }
        }
        if (val > maxPosEntry && !C) {
          p += '-';
          val = BigInt.asIntN(64, maxPosEntry + maxPosEntry + 2n - val);
        }
        if (hexFormat) {
          p += '0x';
          if (bits === 8) p += hex2(val);
          else if (bits === 16) p += hex4(val);
          else if (bits === 32 || bits < 8) p += hex8(val);
          else { p += hex16(val); if (!C) p += 'L'; }
        } else if (bits === 8) p += dec3(val);
        else if (bits === 64) { p += dec5(val); if (!C) p += 'L'; }
        else p += dec5(val);
        if (shiftEntries) p += '<<' + shift;
        if (castEntries) p += ')';
        p += j < table.length - 1 ? ', ' : '  ';
        if ((j & printMask) === printMask) {
          p += ' ' + cs + ' ';
          if (hexComment) p += '0x' + hex4((j & ~commentMask) << (16 - size));
          else p += dec3((j & ~commentMask) >> commentShift);
          if (properties) p += propertiesComments(BigInt.asIntN(64, val << BigInt(extract)));
          p += ce;
        }
        parts.push(p);
      }
    }
    parts.push('\n  };\n\n  ');
    return parts.join('');
  }

  genCaseMapTable() {
    const myTab = '    ';
    let r = myTab + 'charMap = new char[][][] {\n';
    for (const m of this.specialCaseMaps) {
      r += myTab + myTab + '{ ' + "{'\\u" + hex4(m.chSource) + "'}, {";
      for (const c of m.upperCaseMap) r += "'\\u" + hex4(c) + "', ";
      r += '} },\n';
    }
    r += myTab + '};\n';
    this.initializers += r;
  }

  genAccess(tbl, v, bits) {
    let access = null;
    const sizes = this.sizes;
    const bitoffset = bits === 1 ? 5 : bits === 2 ? 4 : bits === 4 ? 3 : 0;
    for (let k = 0; k < sizes.length; k++) {
      const offset = k < sizes.length - 1 ? 0 : bitoffset;
      const shift = this.shifts[k] + offset;
      const shifted = shift === 0 ? v : '(' + v + '>>' + shift + ')';
      const mask = (1 << (sizes[k] - offset)) - 1;
      const masked = k === 0 ? shifted : '(' + shifted + '&0x' + hex(mask) + ')';
      const index = k === 0 ? masked : mask === 0 ? access : '(' + access + '|' + masked + ')';
      const indexNoParens = index[0] !== '(' ? index : index.substring(1, index.length - 1);
      const tblname = k === sizes.length - 1 ? tbl : this.tableNames[k];
      const fetched = tblname + '[' + indexNoParens + ']';
      const zeroextended = this.zeroextend[k] === 0 ? fetched : '(' + fetched + '&0x' + hex(this.zeroextend[k]) + ')';
      const adjustment = this.preshifted[k] ? 0 : sizes[k + 1] - (k === sizes.length - 2 ? bitoffset : 0);
      const adjusted = this.preshifted[k] || adjustment === 0 ? zeroextended
        : '(' + zeroextended + '<<' + adjustment + ')';
      const bitshift = bits === 1 ? '(' + v + '&0x1F)' : bits === 2 ? '((' + v + '&0xF)<<1)'
        : bits === 4 ? '((' + v + '&7)<<2)' : null;
      access = k < sizes.length - 1 || bits >= 8 ? adjusted
        : '((' + adjusted + '>>' + bitshift + ')&' + (bits === 4 ? '0xF' : '' + ((1 << bits) - 1)) + ')';
    }
    return access;
  }

  generateForSizes(map) {
    const sizes = this.sizes;
    let sum = 0;
    this.shifts = new Array(sizes.length);
    for (let k = sizes.length - 1; k >= 0; k--) { this.shifts[k] = sum; sum += sizes[k]; }
    if ((1 << sum) < map.length || (1 << (sum - 1)) >= map.length) {
      this.FAIL(`Bit field widths total to ${sum}: wrong total for map of size ${map.length}`);
    }
    const tables = this.tables = new Array(sizes.length);
    tables[sizes.length - 1] = map;
    for (let j = sizes.length - 1; j > 0; j--) {
      if (this.verbose) process.stderr.write(`Building map ${j + 1} of bit width ${sizes[j]}${LNSEP}`);
      const [newmap, data] = this.buildTable(tables[j], sizes[j]);
      tables[j - 1] = newmap;
      tables[j] = data;
    }
    this.preshifted = new Array(sizes.length).fill(false);
    this.zeroextend = new Array(sizes.length).fill(0);
    this.bytes = new Array(sizes.length).fill(0);
    for (let j = 0; j < sizes.length - 1; j++) {
      let len = tables[j + 1].length;
      const size = sizes[j + 1];
      if (len > 0x100 && (len >> size) <= 0x100) { len >>= size; this.preshifted[j] = false; }
      else if (len > 0x10000 && (len >> size) <= 0x10000) { len >>= size; this.preshifted[j] = false; }
      else this.preshifted[j] = true;
      if (this.Csyntax) this.zeroextend[j] = 0;
      else if (len > 0x7F && len <= 0xFF) { if (!this.useCharForByte) this.zeroextend[j] = 0xFF; }
      else if (len > 0x7FFF && len <= 0xFFFF) this.zeroextend[j] = 0xFFFF;
      else this.zeroextend[j] = 0;
      this.bytes[j] = len <= 0x100 ? 1 : len <= 0x10000 ? 2 : 4;
    }
    this.preshifted[sizes.length - 1] = true;
    this.zeroextend[sizes.length - 1] = 0;
    this.bytes[sizes.length - 1] = 0;
    if (this.verbose) {
      process.stdout.write('    n\t size\tlength\tshift\tzeroext\tbytes\tpreshifted' + LNSEP);
      for (let j = 0; j < sizes.length; j++) {
        process.stdout.write([dec5(j), dec5(sizes[j]), dec5(tables[j].length), dec5(this.shifts[j]),
          dec5(this.zeroextend[j]), dec5(this.bytes[j])].join('\t') + '\t ' + this.preshifted[j] + LNSEP);
      }
      process.stdout.write('Generating source code for class Character' + LNSEP);
      process.stdout.write('A table access looks like ' + this.genAccess('A', 'ch', this.identifiers ? 2 : 32) + LNSEP);
    }
    this.generateCharacterClass(this.files.template, this.files.out);
  }
}
Generator.prototype.tableNames = ['X', 'Y', 'Z', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W'];

function propertiesComments(val) {
  const lo = Number(BigInt.asUintN(32, val));
  const hiBits = val >> 32n;
  let r = '   ';
  const type = lo & maskType;
  const names = { 15: 'Cc', 16: 'Cf', 18: 'Co', 19: 'Cs', 2: 'Ll', 4: 'Lm', 5: 'Lo', 3: 'Lt', 1: 'Lu',
    8: 'Mc', 7: 'Me', 6: 'Mn', 9: 'Nd', 10: 'Nl', 11: 'No', 23: 'Pc', 20: 'Pd', 22: 'Pe', 24: 'Po',
    21: 'Ps', 26: 'Sc', 27: 'Sk', 25: 'Sm', 28: 'So', 13: 'Zl', 14: 'Zp', 12: 'Zs', 0: 'unassigned' };
  if (type in names) r += names[type];
  const bidi = { 0: ', L', 1: ', R', 3: ', EN', 4: ', ES', 5: ', ET', 6: ', AN', 7: ', CS',
    10: ', B', 11: ', S', 12: ', WS', 13: ', ON' };
  const b = (lo & maskBidi) >>> shiftBidi;
  if (b in bidi) r += bidi[b];
  const caseOffset = (lo & maskCaseOffset) >>> shiftCaseOffset;
  if (lo & maskUpperCase) r += ', hasUpper (subtract ' + caseOffset + ')';
  if (lo & maskLowerCase) r += ', hasLower (add ' + caseOffset + ')';
  if (lo & maskTitleCase) r += ', hasTitle';
  const ident = lo & maskIdentifierInfo;
  if (ident === valueIgnorable) r += ', ignorable';
  if (ident === valueJavaUnicodePart) r += ', identifier part';
  if (ident === valueJavaStartUnicodePart) r += ', underscore';
  if (ident === valueJavaWhitespace) r += ', whitespace';
  if (ident === valueJavaOnlyStart) r += ', currency';
  if (ident === valueJavaUnicodeStart) r += ', identifier start';
  const digitOffset = (lo & maskDigitOffset) >> shiftDigitOffset;
  if ((lo & maskNumericType) === valueDigit) r += ', decimal ' + digitOffset;
  if ((lo & maskNumericType) === valueStrangeNumeric) r += ', strange';
  if ((lo & maskNumericType) === valueJavaSupradecimal) r += ', supradecimal ' + digitOffset;
  const hb = name => (hiBits >> BigInt(HI[name])) & 1n;
  const flags = [['maskOtherLowercase', 'otherLowercase'], ['maskOtherUppercase', 'otherUppercase'],
    ['maskOtherAlphabetic', 'otherAlphabetic'], ['maskIdeographic', 'ideographic'],
    ['maskIDStart', 'IDStart'], ['maskIDContinue', 'IDContinue'], ['maskEmoji', 'emoji'],
    ['maskEmojiPresentation', 'emojiPresentation'], ['maskEmojiModifier', 'emojiModifier'],
    ['maskEmojiModifierBase', 'emojiModifierBase'], ['maskEmojiComponent', 'emojiComponent'],
    ['maskExtendedPictographic', 'extendedPictographic']];
  for (const [m, s] of flags) if (hb(m)) r += ', ' + s;
  return r;
}

const SMALL_INITIALIZER =
  '        { // THIS CODE WAS AUTOMATICALLY CREATED BY GenerateCharacter:\n' +
  '            int len = $$name_DATA.length();\n' +
  '            int j=0;\n' +
  '            for (int i=0; i<len; ++i) {\n' +
  '                int c = $$name_DATA.charAt(i);\n' +
  '                for (int k=0; k<$$entriesPerChar; ++k) {\n' +
  '                    $$name[j++] = ($$type)c;\n' +
  '                    c >>= $$bits;\n' +
  '                }\n' +
  '            }\n' +
  '            assert (j == $$size);\n' +
  '        }\n';

const SAME_SIZE_INITIALIZER =
  '        { // THIS CODE WAS AUTOMATICALLY CREATED BY GenerateCharacter:\n' +
  '            assert ($$name_DATA.length() == $$size);\n' +
  '            for (int i=0; i<$$size; ++i)\n' +
  '                $$name[i] = ($$type)$$name_DATA.charAt(i);\n' +
  '        }\n';

const BIG_INITIALIZER =
  '        { // THIS CODE WAS AUTOMATICALLY CREATED BY GenerateCharacter:\n' +
  '            int len = $$name_DATA.length();\n' +
  '            int j=0;\n' +
  '            int charsInEntry=0;\n' +
  '            $$type entry=0;\n' +
  '            for (int i=0; i<len; ++i) {\n' +
  '                entry |= $$name_DATA.charAt(i);\n' +
  '                if (++charsInEntry == $$charsPerEntry) {\n' +
  '                    $$name[j++] = entry;\n' +
  '                    entry = 0;\n' +
  '                    charsInEntry = 0;\n' +
  '                }\n' +
  '                else {\n' +
  '                    entry <<= 16;\n' +
  '                }\n' +
  '            }\n' +
  '            assert (j == $$size);\n' +
  '        }\n';

const INT32_INITIALIZER =
  '        { // THIS CODE WAS AUTOMATICALLY CREATED BY GenerateCharacter:\n' +
  '            char[] data = $$name_DATA.toCharArray();\n' +
  '            assert (data.length == ($$size * 2));\n' +
  '            int i = 0, j = 0;\n' +
  '            while (i < ($$size * 2)) {\n' +
  '                int entry = data[i++] << 16;\n' +
  '                $$name[j++] = entry | data[i++];\n' +
  '            }\n' +
  '        }\n';

function main(args) {
  const g = new Generator();
  g.processArgs(args);
  const f = g.files;
  const data = readUnicodeSpec(f.spec, g.plane);
  g.specialCaseMaps = readSpecialCasing(f.specialcasing, g.plane);
  const propMap = new Map();
  readPropList(f.proplist, g.plane, propMap);
  readPropList(f.derivedprops, g.plane, propMap);
  const emoji = readEmojiData(f.emojidata, g.plane);
  if (g.verbose) process.stdout.write(`${data.length} items read from Unicode spec file ${f.spec}${LNSEP}`);
  const map = g.buildMap(data, propMap, emoji);
  g.generateForSizes(map);
  if (g.verbose) process.stdout.write('Done!' + LNSEP);
  return 0;
}

module.exports = { main, formatForSource, parseSpec };
