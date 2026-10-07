'use strict';
// Port of make/jdk/src/classes/build/tools/generatebreakiteratordata/
// (GenerateBreakIteratorData, CharacterCategory, CharSet,
// RuleBasedBreakIteratorBuilder, DictionaryBasedBreakIteratorBuilder,
// SupplementaryCharacterData) and sun.text.CompactByteArray: compiles the
// break iterator rules into the sun/text/resources/*BreakIteratorData files.
//
// The Java tool loads the rules from the compiled BreakIteratorInfo /
// BreakIteratorRules bundles put on its module path; this port reads their
// sources, located relative to the -spec file
// (<top>/src/java.base/share/data/unicodedata/UnicodeData.txt).
//
// usage: GenerateBreakIteratorData -o dir -spec UnicodeData.txt [-language l]
const fs = require('fs');
const path = require('path');
const { readLines } = require('./genchar-common');
const { readBundle } = require('./genbreakiter-src');

// Java's String.hashCode
function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// java.util.Hashtable<String, V>, for its enumeration order
class JHashtable {
  constructor() { this.table = new Array(11).fill(null); this.count = 0; this.threshold = 8; }
  index(hash, len) { return (hash & 0x7FFFFFFF) % len; }
  get(key) {
    const hash = stringHash(key);
    for (let e = this.table[this.index(hash, this.table.length)]; e; e = e.next) {
      if (e.hash === hash && e.key === key) return e.value;
    }
    return null;
  }
  put(key, value) {
    const hash = stringHash(key);
    let idx = this.index(hash, this.table.length);
    for (let e = this.table[idx]; e; e = e.next) {
      if (e.hash === hash && e.key === key) { e.value = value; return; }
    }
    if (this.count >= this.threshold) {
      const old = this.table, cap = old.length * 2 + 1, nt = new Array(cap).fill(null);
      this.threshold = Math.floor(cap * 0.75);
      for (let i = old.length; i-- > 0;) {
        for (let o = old[i]; o;) {
          const e = o;
          o = o.next;
          const ni = this.index(e.hash, cap);
          e.next = nt[ni];
          nt[ni] = e;
        }
      }
      this.table = nt;
      idx = this.index(hash, cap);
    }
    this.table[idx] = { hash, key, value, next: this.table[idx] };
    this.count++;
  }
  // keys() / elements() order
  entries() {
    const out = [];
    for (let i = this.table.length; i-- > 0;) for (let e = this.table[i]; e; e = e.next) out.push(e);
    return out;
  }
}

// CharacterCategory
const categoryNames = ['Ll', 'Lu', 'Lt', 'Lo', 'Lm', 'Nd', 'Nl', 'No', 'Ps', 'Pe', 'Pi', 'Pf',
  'Pd', 'Pc', 'Po', 'Sc', 'Sm', 'So', 'Mn', 'Mc', 'Me', 'Zl', 'Zp', 'Zs', 'Cc', 'Cf', '--'];

function makeCategoryMap(specfile) {
  const n = categoryNames.length;
  const newList = categoryNames.map(() => []);
  const bmpCount = new Array(n).fill(0);
  const append = (index, code) => {
    newList[index].push(code);
    if (code < 0x10000) bmpCount[index]++;
  };
  let prevIndex = n - 1, prevCodeValue = -1, setFirst = false;
  for (const line of readLines(specfile)) {
    if (line.length === 0) continue;
    const tokens = line.split(';').filter(t => t !== '');
    const code = tokens[0];
    if (code[0] === '#' || code[0] === '/') continue;
    const characterName = tokens[1], category = tokens[2];
    const index = categoryNames.indexOf(category);
    if (index < 0) continue;
    const curCodeValue = parseInt(code, 16);
    if (prevIndex === index) {
      if (setFirst) {
        if (characterName.endsWith(' Last>')) setFirst = false;
        else process.stderr.write('*** Error 1 at ' + code + '\n');
      } else if (characterName.endsWith(' First>')) setFirst = true;
      else if (characterName.endsWith(' Last>')) process.stderr.write('*** Error 2 at ' + code + '\n');
      else if (prevCodeValue !== curCodeValue - 1) {
        append(prevIndex, prevCodeValue);
        append(index, curCodeValue);
      }
    } else {
      if (setFirst) process.stderr.write('*** Error 3 at ' + code + '\n');
      else if (characterName.endsWith(' First>')) setFirst = true;
      else if (characterName.endsWith(' Last>')) process.stderr.write('*** Error 4 at ' + code + '\n');
      append(prevIndex, prevCodeValue);
      append(index, curCodeValue);
      prevIndex = index;
    }
    prevCodeValue = curCodeValue;
  }
  append(prevIndex, prevCodeValue);
  if (bmpCount[n - 1] !== 1) {
    throw new Error('This should not happen. Unicode data which belongs to an undefined category exists');
  }
  return newList.slice(0, n - 1);
}

// CharSet: sorted [start, end] pairs of code points
class CharSet {
  constructor(chars) { this.chars = chars || []; }
  static of(lo, hi = lo) { return new CharSet(lo <= hi ? [lo, hi] : [hi, lo]); }
  empty() { return this.chars.length === 0; }
  equals(that) {
    const a = this.chars, b = that.chars;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  union(that) { return new CharSet(doUnion(this.chars, that.chars)); }
  intersection(that) { return new CharSet(doIntersection(this.chars, that.chars)); }
  difference(that) { return new CharSet(doIntersection(this.chars, doComplement(that.chars))); }
}

function doUnion(chars, c2) {
  const result = [];
  let i = 0, j = 0;
  while (i < chars.length && j < c2.length) {
    let ub;
    if (chars[i] < c2[j]) { result.push(chars[i]); ub = chars[++i]; }
    else { result.push(c2[j]); ub = c2[++j]; }
    while (i % 2 === 1 || j % 2 === 1 || (i < chars.length && chars[i] <= ub + 1)) {
      while (i < chars.length && chars[i] <= ub + 1) ++i;
      if (i % 2 === 1) ub = chars[i];
      else if (i > 0 && chars[i - 1] > ub) ub = chars[i - 1];
      while (j < c2.length && c2[j] <= ub + 1) ++j;
      if (j % 2 === 1) ub = c2[j];
      else if (j > 0 && c2[j - 1] > ub) ub = c2[j - 1];
    }
    result.push(ub);
  }
  for (let k = i; k < chars.length; k++) result.push(chars[k]);
  for (let k = j; k < c2.length; k++) result.push(c2[k]);
  return result;
}

function doIntersection(chars, c2) {
  const result = [];
  let i = 0, j = 0;
  while (i < chars.length && j < c2.length) {
    if (i < chars.length && i % 2 === 0) {
      while (j < c2.length && c2[j] < chars[i]) ++j;
      if (j < c2.length && j % 2 === 0 && c2[j] === chars[i]) ++j;
    }
    let oldI = i;
    while (j % 2 === 1 && i < chars.length && chars[i] <= c2[j]) ++i;
    for (let k = oldI; k < i; k++) result.push(chars[k]);
    const oldJ = j;
    while (i % 2 === 1 && j < c2.length && c2[j] <= chars[i]) ++j;
    for (let k = oldJ; k < j; k++) result.push(c2[k]);
    if (j < c2.length && j % 2 === 0) {
      while (i < chars.length && chars[i] < c2[j]) ++i;
      if (i < chars.length && i % 2 === 0 && c2[j] === chars[i]) ++i;
    }
  }
  return result;
}

function doComplement(chars) {
  if (chars.length === 0) return [0, 0x10FFFF];
  const result = [];
  let i = 0;
  if (chars[0] !== 0) result.push(0);
  while (i < chars.length) {
    if (chars[i] !== 0) result.push(chars[i] - 1);
    if (chars[i + 1] !== 0x10FFFF) result.push(chars[i + 1] + 1);
    i += 2;
  }
  if (chars[i - 1] !== 0x10FFFF) result.push(0x10FFFF);
  return result;
}

const charCount = c => c >= 0x10000 ? 2 : 1;
const isAsciiAlnum = c => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isLetterOrDigit = c => /[\p{L}\p{Nd}]/u.test(String.fromCodePoint(c));

class CharSetParser {
  constructor(categoryMap) { this.categoryMap = categoryMap; }

  parseString(s) {
    return new CharSet(this.doParseString(s).chars);
  }

  forCategory(category) {
    if (category.length === 0 || category.length >= 3) throw new Error('Invalid character category: ' + category);
    if (category.length === 2) {
      const i = categoryNames.indexOf(category);
      if (i < 0) throw new Error('Invalid character category: ' + category);
      return new CharSet(this.categoryMap[i]);
    }
    let result = new CharSet();
    for (let i = 0; i < categoryNames.length; i++) {
      if (categoryNames[i].startsWith(category)) result = result.union(new CharSet(this.categoryMap[i]));
    }
    if (result.empty()) throw new Error('Invalid character category: ' + category);
    return result;
  }

  doParseString(s) {
    const fail = p => { throw new Error('Parse error at position ' + p + ' in ' + s); };
    const result = new CharSet();
    const union = cs => { result.chars = doUnion(result.chars, cs.chars); };
    const diff = cs => { result.chars = doIntersection(result.chars, doComplement(cs.chars)); };
    let p = 0, haveDash = false, haveTilde = false, wIsReal = false, w = 0;
    while (p < s.length) {
      const c = s.codePointAt(p);
      if (c === 0x5b) { // [
        if (wIsReal) union(CharSet.of(w));
        let bracketLevel = 1, q = p + 1;
        while (bracketLevel !== 0) {
          if (q >= s.length) fail(p);
          let ch = s.codePointAt(q);
          if (ch === 0x5c) ch = s.codePointAt(++q);
          else if (ch === 0x5b) ++bracketLevel;
          else if (ch === 0x5d) --bracketLevel;
          q += charCount(ch);
        }
        --q;
        const inner = this.parseString(s.substring(p + 1, q));
        if (!haveTilde) union(inner); else diff(inner);
        haveTilde = haveDash = wIsReal = false;
        p = q + 1;
      } else if (c === 0x3a) { // :
        if (wIsReal) union(CharSet.of(w));
        const q = s.indexOf(':', p + 1);
        if (q === -1) fail(p);
        const cat = this.forCategory(s.substring(p + 1, q));
        if (!haveTilde) union(cat); else diff(cat);
        haveTilde = haveDash = wIsReal = false;
        p = q + 1;
      } else if (c === 0x2d) { // -
        if (wIsReal) haveDash = true;
        ++p;
      } else if (c === 0x5e) { // ^
        if (wIsReal) { union(CharSet.of(w)); wIsReal = false; }
        haveTilde = true;
        ++p;
        if (result.empty()) result.chars = doComplement(result.chars);
      } else if (c >= 0x20 && c < 0x7f && !isAsciiAlnum(c) && c !== 0x5c) {
        fail(p);
      } else {
        if (c === 0x5c) ++p;
        if (haveDash) {
          const ch = s.codePointAt(p);
          if (ch < w) {
            throw new Error(`U+${ch.toString(16)} is less than U+${w.toString(16)}.  Dash expressions ` +
              "can't have their endpoints in reverse order.");
          }
          if (!haveTilde) union(CharSet.of(w, ch)); else diff(CharSet.of(w, ch));
          p += charCount(ch);
          haveDash = haveTilde = wIsReal = false;
        } else if (haveTilde) {
          w = s.codePointAt(p);
          diff(CharSet.of(w));
          p += charCount(w);
          haveTilde = wIsReal = false;
        } else if (wIsReal) {
          union(CharSet.of(w));
          w = s.codePointAt(p);
          p += charCount(w);
          wIsReal = true;
        } else {
          w = s.codePointAt(p);
          p += charCount(w);
          wIsReal = true;
        }
      }
    }
    if (wIsReal) union(CharSet.of(w));
    return result;
  }
}

// sun.text.CompactByteArray (as used here: set ranges, then compact)
const BLOCKSHIFT = 7, BLOCKCOUNT = 1 << BLOCKSHIFT, INDEXCOUNT = 1 << (16 - BLOCKSHIFT);
class CompactByteArray {
  constructor() {
    this.values = new Int8Array(65536);
    this.indices = new Int16Array(INDEXCOUNT);
    this.hashes = new Int32Array(INDEXCOUNT);
    for (let i = 0; i < INDEXCOUNT; ++i) this.indices[i] = i << BLOCKSHIFT;
  }
  setElementAt(start, end, value) {
    for (let i = start; i <= end; ++i) {
      this.values[i] = value;
      const b = i >> BLOCKSHIFT;
      this.hashes[b] = (this.hashes[b] + (value << 1)) | 1;
    }
  }
  compact() {
    const values = this.values, indices = this.indices, hashes = this.hashes;
    let limitCompacted = 0, iBlockStart = 0, iUntouched = -1;
    for (let i = 0; i < indices.length; ++i, iBlockStart += BLOCKCOUNT) {
      indices[i] = -1;
      const touched = hashes[i] !== 0;
      if (!touched && iUntouched !== -1) {
        indices[i] = iUntouched;
      } else {
        let jBlockStart = 0, j = 0;
        for (j = 0; j < limitCompacted; ++j, jBlockStart += BLOCKCOUNT) {
          if (hashes[i] === hashes[j] && regionMatches(values, iBlockStart, jBlockStart)) {
            indices[i] = jBlockStart;
            break;
          }
        }
        if (indices[i] === -1) {
          values.copyWithin(jBlockStart, iBlockStart, iBlockStart + BLOCKCOUNT);
          indices[i] = jBlockStart;
          hashes[j] = hashes[i];
          ++limitCompacted;
          if (!touched) iUntouched = jBlockStart;
        }
      }
    }
    this.values = values.slice(0, limitCompacted * BLOCKCOUNT);
  }
}
function regionMatches(v, a, b) {
  for (let k = 0; k < BLOCKCOUNT; k++) if (v[a + k] !== v[b + k]) return false;
  return true;
}

// SupplementaryCharacterData
const UPPER_LIMIT = 0x110000;
class SupplementaryCharacterData {
  constructor() { this.temp = []; }
  appendElement(start, end, value) {
    this.temp.push((((BigInt(start) << 24n) + BigInt(end)) << 8n) + BigInt(value));
  }
  complete() {
    const compose = (cp, value) => (cp << 8) | (value & 0xFF);
    const t = this.temp;
    if (t.length === 0) { this.dataTable = [compose(0, 0), compose(UPPER_LIMIT, 0)]; return; }
    t.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out = [];
    const low = d => Number(BigInt.asIntN(32, d));
    let data = t[0];
    let start = Number(BigInt.asIntN(32, data >> 32n)) & 0x1FFFFF;
    let end = Number(BigInt.asIntN(32, data >> 8n)) & 0x1FFFFF;
    if (start !== 0x10000) out.push(compose(0x10000, 0));
    out.push(compose(start, low(data)));
    for (let i = 1; i < t.length; i++) {
      data = t[i];
      const nextStart = Number(BigInt.asIntN(32, data >> 32n)) & 0x1FFFFF;
      if (end !== start && end !== nextStart - 1) out.push(compose(end + 1, 0));
      out.push(compose(nextStart, low(data)));
      start = nextStart;
      end = Number(BigInt.asIntN(32, data >> 8n)) & 0x1FFFFF;
    }
    out.push(compose(++end, 0));
    if (end < UPPER_LIMIT) out.push(compose(UPPER_LIMIT, 0));
    this.dataTable = out;
  }
}

const IGNORE = -1;
const END_STATE_FLAG = 0x8000, DONT_LOOP_FLAG = 0x4000, LOOKAHEAD_STATE_FLAG = 0x2000;
const ALL_FLAGS = END_STATE_FLAG | LOOKAHEAD_STATE_FLAG | DONT_LOOP_FLAG;
const toShort = v => (v << 16) >> 16;

function ruleError(message, position, context) {
  throw new Error(`Parse error at position (${position}): ${message}\n` +
    context.substring(0, position) + ' -here- ' + context.substring(position));
}

class RuleBasedBreakIteratorBuilder {
  constructor(description, parser, dictionary) {
    this.parser = parser;
    this.dictionary = dictionary;
    this.ignoreChars = null;
    this.additionalData = null;
    this.mergeList = null;
    this.clearLoopingStates = false;
    if (dictionary) { this.dictionaryChars = null; this.dictionaryExpression = null; }
    const tempRuleList = this.buildRuleList(description);
    this.buildCharCategories(tempRuleList);
    this.buildStateTable(tempRuleList);
    this.buildBackwardsStateTable(tempRuleList);
  }

  buildRuleList(description) {
    const tempRuleList = [];
    const parenStack = [];
    let p = 0, ruleStart = 0, c = 0, lastC = 0, lastOpen = 0;
    let haveEquals = false, havePipe = false, sawVarName = false;
    const cantPrecedeAsterisk = '=/{(|}*;\u0000';
    if (description.length !== 0 && description.codePointAt(description.length - 1) !== 0x3b) description += ';';
    while (p < description.length) {
      c = description.codePointAt(p);
      const ch = String.fromCodePoint(c);
      switch (ch) {
        case '\\':
          ++p;
          break;
        case '{': case '<': case '[': case '(':
          if (lastOpen === 0x3c) ruleError("Can't nest brackets inside <>", p, description);
          if (lastOpen === 0x5b && ch !== '[') ruleError("Can't nest anything in [] but []", p, description);
          if (ch === '<' && (haveEquals || havePipe)) ruleError('Unknown variable name', p, description);
          lastOpen = c;
          parenStack.push(c & 0xffff);
          if (ch === '<') sawVarName = true;
          break;
        case '}': case '>': case ']': case ')': {
          const expectedClose = { '{': '}', '[': ']', '(': ')', '<': '>' }[String.fromCharCode(lastOpen)] || '\0';
          if (ch !== expectedClose) ruleError('Unbalanced parentheses', p, description);
          if (lastC === lastOpen) ruleError("Parens don't contain anything", p, description);
          parenStack.pop();
          lastOpen = parenStack.length ? parenStack[parenStack.length - 1] : 0;
          break;
        }
        case '*':
          if (cantPrecedeAsterisk.includes(String.fromCodePoint(lastC))) ruleError('Misplaced asterisk', p, description);
          break;
        case '?':
          if (lastC !== 0x2a) ruleError('Misplaced ?', p, description);
          break;
        case '=':
          if (haveEquals || havePipe) ruleError('More than one = or / in rule', p, description);
          haveEquals = true;
          break;
        case '/':
          if (haveEquals || havePipe) ruleError('More than one = or / in rule', p, description);
          if (sawVarName) ruleError('Unknown variable name', p, description);
          havePipe = true;
          break;
        case '!':
          if (lastC !== 0x3b && lastC !== 0) ruleError('! can only occur at the beginning of a rule', p, description);
          break;
        case '.':
          break;
        case '^': case '-': case ':':
          if (lastOpen !== 0x5b && lastOpen !== 0x3c) ruleError('Illegal character', p, description);
          break;
        case ';':
          if (lastC === 0x3b || lastC === 0) ruleError('Empty rule', p, description);
          if (parenStack.length) ruleError('Unbalanced parenheses', p, description);
          if (haveEquals) {
            description = this.processSubstitution(description.substring(ruleStart, p), description, p + 1);
          } else {
            if (sawVarName) ruleError('Unknown variable name', p, description);
            tempRuleList.push(description.substring(ruleStart, p));
          }
          ruleStart = p + 1;
          haveEquals = havePipe = sawVarName = false;
          break;
        case '|':
          if (lastC === 0x7c) ruleError('Empty alternative', p, description);
          if (!parenStack.length || lastOpen !== 0x28) ruleError('Misplaced |', p, description);
          break;
        default:
          if (c >= 0x20 && c < 0x7f && !isAsciiAlnum(c)) ruleError('Illegal character', p, description);
          if (c >= 0x10000) ++p;
          break;
      }
      lastC = c;
      ++p;
    }
    if (tempRuleList.length === 0) ruleError('No valid rules in description', p, description);
    return tempRuleList;
  }

  processSubstitution(substitutionRule, description, startPos) {
    const equalPos = substitutionRule.indexOf('=');
    const replace = substitutionRule.substring(0, equalPos);
    const replaceWith = substitutionRule.substring(equalPos + 1);
    this.handleSpecialSubstitution(replace, replaceWith, startPos, description);
    if (replaceWith.length === 0) ruleError('Nothing on right-hand side of =', startPos, description);
    if (replace.length === 0) ruleError('Nothing on left-hand side of =', startPos, description);
    if (replace.length === 2 && replace[0] !== '\\') ruleError('Illegal left-hand side for =', startPos, description);
    if (replace.length >= 3 && replace[0] !== '<' && replace.codePointAt(equalPos - 1) !== 0x3e) {
      ruleError('Illegal left-hand side for =', startPos, description);
    }
    if (!(replaceWith[0] === '[' && replaceWith[replaceWith.length - 1] === ']') &&
        !(replaceWith[0] === '(' && replaceWith[replaceWith.length - 1] === ')')) {
      ruleError('Illegal right-hand side for =', startPos, description);
    }
    let result = description.substring(0, startPos);
    let lastPos = startPos;
    let pos = description.indexOf(replace, startPos);
    while (pos !== -1) {
      result += description.substring(lastPos, pos) + replaceWith;
      lastPos = pos + replace.length;
      pos = description.indexOf(replace, lastPos);
    }
    return result + description.substring(lastPos);
  }

  handleSpecialSubstitution(replace, replaceWith, startPos, description) {
    if (replace === '<ignore>') {
      if (replaceWith[0] === '(') ruleError("Ignore group can't be enclosed in (", startPos, description);
      this.ignoreChars = this.parser.parseString(replaceWith);
    }
    if (this.dictionary && replace === '<dictionary>') {
      if (replaceWith[0] === '(') ruleError("Dictionary group can't be enclosed in (", startPos, description);
      this.dictionaryExpression = replaceWith;
      this.dictionaryChars = this.parser.parseString(replaceWith);
    }
  }

  buildCharCategories(tempRuleList) {
    let bracketLevel = 0;
    const expressions = this.expressions = new JHashtable();
    for (const line of tempRuleList) {
      let p = 0;
      while (p < line.length) {
        let c = line.codePointAt(p);
        switch (String.fromCodePoint(c)) {
          case '{': case '}': case '(': case ')': case '*': case '.':
          case '/': case '|': case ';': case '?': case '!':
            break;
          case '[': {
            let q = p + 1;
            ++bracketLevel;
            while (q < line.length && bracketLevel !== 0) {
              c = line.codePointAt(q);
              if (c === 0x5c) q++;
              else if (c === 0x5b) ++bracketLevel;
              else if (c === 0x5d) --bracketLevel;
              q += charCount(c);
            }
            const key = line.substring(p, q);
            if (expressions.get(key) === null) expressions.put(key, this.parser.parseString(key));
            p = q - 1;
            break;
          }
          case '\\':
            ++p;
            // falls through
          default: {
            const key = line.substring(p, p + 1);
            expressions.put(key, this.parser.parseString(key));
            break;
          }
        }
        p += charCount(line.codePointAt(p));
      }
    }
    const categories = this.categories = [this.ignoreChars !== null ? this.ignoreChars : new CharSet()];
    this.ignoreChars = null;
    if (this.dictionary) expressions.put(this.dictionaryExpression, this.dictionaryChars);
    for (const entry of expressions.entries()) {
      let e = entry.value;
      for (let j = categories.length - 1; !e.empty() && j > 0; j--) {
        const that = categories[j];
        if (!that.intersection(e).empty()) {
          let temp = that.difference(e);
          if (!temp.empty()) categories.push(temp);
          temp = e.intersection(that);
          e = e.difference(that);
          if (!temp.equals(that)) categories[j] = temp;
        }
      }
      if (!e.empty()) categories.push(e);
    }
    let allChars = new CharSet();
    for (let i = 1; i < categories.length; i++) allChars = allChars.union(categories[i]);
    categories[0] = categories[0].difference(allChars);
    for (const entry of expressions.entries()) {
      const cs = entry.value;
      let cats = '';
      for (let j = 0; j < categories.length; j++) {
        const temp = cs.intersection(categories[j]);
        if (!temp.empty()) {
          cats += String.fromCharCode(0x100 + j);
          if (temp.equals(cs)) break;
        }
      }
      entry.value = cats;
    }
    const table = this.charCategoryTable = new CompactByteArray();
    const supp = this.supplementaryCharCategoryTable = new SupplementaryCharacterData();
    for (let i = 0; i < categories.length; i++) {
      const chars = categories[i].chars;
      const v = i !== 0 ? (i << 24) >> 24 : IGNORE;
      for (let k = 0; k < chars.length; k += 2) {
        const lo = chars[k], hi = chars[k + 1];
        if (lo < 0x10000) {
          if (hi < 0x10000) table.setElementAt(lo, hi, v);
          else {
            table.setElementAt(lo, 0xFFFF, v);
            supp.appendElement(0x10000, hi, v);
          }
        } else supp.appendElement(lo, hi, v);
      }
    }
    table.compact();
    supp.complete();
    this.numCategories = categories.length;
    if (this.dictionary) {
      this.categoryFlags = categories.map(cs => !cs.intersection(this.dictionaryChars).empty());
    }
  }

  newRow() { return new Int16Array(this.numCategories + 1); }

  buildStateTable(tempRuleList) {
    this.tempStateTable = [this.newRow(), this.newRow()];
    for (const rule of tempRuleList) if (rule[0] !== '!') this.parseRule(rule, true);
    this.finishBuildingStateTable(true);
  }

  parseRule(rule, forward) {
    const N = this.numCategories, tst = this.tempStateTable;
    let p = 0, currentState = 1, lastState = currentState, pendingChars = '';
    this.decisionPointStack = [];
    this.decisionPointList = [];
    this.loopingStates = [];
    this.statesToBackfill = [];
    let state, sawEarlyBreak = false;
    if (!forward) this.loopingStates.push(1);
    this.decisionPointList.push(currentState);
    currentState = tst.length - 1;
    while (p < rule.length) {
      let c = rule.codePointAt(p);
      this.clearLoopingStates = false;
      if (c === 0x5b || c === 0x5c || isLetterOrDigit(c) || c < 0x20 || c === 0x2e || c >= 0x7f) {
        if (c !== 0x2e) {
          let q = p;
          if (c === 0x5c) { q = p + 2; ++p; }
          else if (c === 0x5b) {
            let bracketLevel = 1;
            q += charCount(rule.codePointAt(q));
            while (bracketLevel > 0) {
              c = rule.codePointAt(q);
              if (c === 0x5b) ++bracketLevel;
              else if (c === 0x5d) --bracketLevel;
              else if (c === 0x5c) c = rule.codePointAt(++q);
              q += charCount(c);
            }
          } else q = p + charCount(c);
          pendingChars = this.expressions.get(rule.substring(p, q));
          if (pendingChars === null) throw new TypeError('NullPointerException');
          // codePointBefore(q)
          const before = rule.charCodeAt(q - 1);
          const twoUnits = before >= 0xdc00 && before <= 0xdfff && q - 2 >= 0 &&
            rule.charCodeAt(q - 2) >= 0xd800 && rule.charCodeAt(q - 2) <= 0xdbff;
          p = q - (twoUnits ? 2 : 1);
        } else {
          const rowNum = this.decisionPointList[this.decisionPointList.length - 1];
          state = tst[rowNum];
          if (p + 1 < rule.length && rule[p + 1] === '*' && state[0] !== 0) {
            this.decisionPointList.push(state[0]);
            pendingChars = '';
            ++p;
          } else {
            pendingChars = '';
            for (let i = 0; i < N; i++) pendingChars += String.fromCharCode(i + 0x100);
          }
        }
        if (pendingChars.length !== 0) {
          if (p + 1 < rule.length && rule[p + 1] === '*') this.decisionPointStack.push(this.decisionPointList.slice());
          const newState = tst.length;
          if (this.loopingStates.length !== 0) this.statesToBackfill.push(newState);
          state = this.newRow();
          if (sawEarlyBreak) state[N] = DONT_LOOP_FLAG;
          tst.push(state);
          this.updateStateTable(this.decisionPointList, pendingChars, toShort(newState));
          this.decisionPointList.length = 0;
          lastState = currentState;
          do {
            ++currentState;
            this.decisionPointList.push(currentState);
          } while (currentState + 1 < tst.length);
        }
      } else if (c === 0x7b) { // {
        this.decisionPointStack.push(this.decisionPointList.slice());
      } else if (c === 0x7d || c === 0x2a) { // } *
        if (c === 0x2a) {
          for (let i = lastState + 1; i < tst.length; i++) {
            this.updateStateTable([i], pendingChars, toShort(lastState + 1));
          }
        }
        const temp = this.decisionPointStack.pop();
        for (const d of this.decisionPointList) temp.push(d);
        this.decisionPointList = temp;
      } else if (c === 0x3f) { // ?
        this.setLoopingStates(this.decisionPointList, this.decisionPointList);
      } else if (c === 0x28) { // (
        tst.push(this.newRow());
        lastState = currentState;
        ++currentState;
        this.decisionPointList.unshift(currentState);
        this.decisionPointStack.push(this.decisionPointList.slice());
        this.decisionPointStack.push([]);
      } else if (c === 0x7c) { // |
        const oneDown = this.decisionPointStack.pop();
        const twoDown = this.decisionPointStack[this.decisionPointStack.length - 1];
        this.decisionPointStack.push(oneDown);
        for (const d of this.decisionPointList) oneDown.push(d);
        this.decisionPointList = twoDown.slice();
      } else if (c === 0x29) { // )
        let exitPoints = this.decisionPointStack.pop();
        for (const d of this.decisionPointList) exitPoints.push(d);
        this.decisionPointList = exitPoints;
        if (p + 1 >= rule.length || rule[p + 1] !== '*') {
          this.decisionPointStack.pop();
        } else {
          exitPoints = this.decisionPointList.slice();
          const temp = this.decisionPointStack.pop();
          const tempStateNum = temp[0];
          const tempState = tst[tempStateNum];
          for (const d of this.decisionPointList) temp.push(d);
          this.decisionPointList = temp;
          for (let i = 0; i < tempState.length; i++) {
            if (tempState[i] > tempStateNum) {
              this.updateStateTable(exitPoints, String.fromCharCode((i + 0x100) & 0xffff), tempState[i]);
            }
          }
          lastState = currentState;
          currentState = tst.length - 1;
          ++p;
        }
      } else if (c === 0x2f) { // /
        sawEarlyBreak = true;
        for (const d of this.decisionPointList) tst[d][N] |= LOOKAHEAD_STATE_FLAG;
      }
      if (this.clearLoopingStates) this.setLoopingStates(null, this.decisionPointList);
      p += charCount(c);
    }
    this.setLoopingStates(null, this.decisionPointList);
    for (const rowNum of this.decisionPointList) {
      state = tst[rowNum];
      state[N] |= toShort(END_STATE_FLAG);
      if (sawEarlyBreak) state[N] |= LOOKAHEAD_STATE_FLAG;
    }
  }

  updateStateTable(rows, pendingChars, newValue) {
    const newValues = this.newRow();
    for (let i = 0; i < pendingChars.length; i++) newValues[pendingChars.charCodeAt(i) - 0x100] = newValue;
    for (let i = 0; i < rows.length; i++) this.mergeStates(rows[i], newValues, rows);
  }

  mergeStates(rowNum, newValues, rowsBeingUpdated) {
    const N = this.numCategories, tst = this.tempStateTable;
    const oldValues = tst[rowNum];
    const isLoopingState = this.loopingStates.includes(rowNum);
    for (let i = 0; i < oldValues.length; i++) {
      if (oldValues[i] === newValues[i]) continue;
      else if (isLoopingState && this.loopingStates.includes(oldValues[i])) {
        if (newValues[i] !== 0) {
          if (oldValues[i] === 0) this.clearLoopingStates = true;
          oldValues[i] = newValues[i];
        }
      } else if (oldValues[i] === 0) {
        oldValues[i] = newValues[i];
      } else if (i === N) {
        oldValues[i] = (newValues[i] & ALL_FLAGS) | oldValues[i];
      } else if (oldValues[i] !== 0 && newValues[i] !== 0) {
        let combinedRowNum = this.searchMergeList(oldValues[i], newValues[i]);
        if (combinedRowNum !== 0) {
          oldValues[i] = combinedRowNum;
        } else {
          const oldRowNum = oldValues[i], newRowNum = newValues[i];
          combinedRowNum = tst.length;
          if (this.mergeList === null) this.mergeList = [];
          this.mergeList.push([oldRowNum, newRowNum, combinedRowNum]);
          const newRow = this.newRow();
          newRow.set(tst[oldRowNum].subarray(0, N + 1));
          tst.push(newRow);
          oldValues[i] = combinedRowNum;
          const dpl0 = this.decisionPointList;
          if ((dpl0.includes(oldRowNum) || dpl0.includes(newRowNum)) && !dpl0.includes(combinedRowNum)) {
            dpl0.push(combinedRowNum);
          }
          if ((rowsBeingUpdated.includes(oldRowNum) || rowsBeingUpdated.includes(newRowNum)) &&
              !rowsBeingUpdated.includes(combinedRowNum)) {
            this.decisionPointList.push(combinedRowNum);
          }
          for (const dpl of this.decisionPointStack) {
            if ((dpl.includes(oldRowNum) || dpl.includes(newRowNum)) && !dpl.includes(combinedRowNum)) {
              dpl.push(combinedRowNum);
            }
          }
          this.mergeStates(combinedRowNum, tst[newValues[i]], rowsBeingUpdated);
        }
      }
    }
  }

  searchMergeList(a, b) {
    if (this.mergeList === null) return 0;
    for (const entry of this.mergeList) {
      if ((entry[0] === a && entry[1] === b) || (entry[0] === b && entry[1] === a)) return entry[2];
      if (entry[2] === a && (entry[0] === b || entry[1] === b)) return entry[2];
      if (entry[2] === b && (entry[0] === a || entry[1] === a)) return entry[2];
    }
    return 0;
  }

  setLoopingStates(newLoopingStates, endStates) {
    const N = this.numCategories;
    if (this.loopingStates.length !== 0) {
      const loopingState = this.loopingStates[this.loopingStates.length - 1];
      for (let i = 0; i < endStates.length; i++) this.eliminateBackfillStates(endStates[i]);
      for (const rowNum of this.statesToBackfill) {
        const state = this.tempStateTable[rowNum];
        state[N] = (state[N] & ALL_FLAGS) | loopingState;
      }
      this.statesToBackfill.length = 0;
      this.loopingStates.length = 0;
    }
    if (newLoopingStates !== null) this.loopingStates = newLoopingStates.slice();
  }

  eliminateBackfillStates(baseState) {
    const k = this.statesToBackfill.indexOf(baseState);
    if (k >= 0) {
      this.statesToBackfill.splice(k, 1);
      const state = this.tempStateTable[baseState];
      for (let i = 0; i < this.numCategories; i++) {
        if (state[i] !== 0) this.eliminateBackfillStates(state[i]);
      }
    }
  }

  backfillLoopingStates() {
    const N = this.numCategories, tst = this.tempStateTable;
    let loopingState = null, loopingStateRowNum = 0;
    for (let i = 0; i < tst.length; i++) {
      const state = tst[i];
      const fromState = state[N] & ~ALL_FLAGS;
      if (fromState > 0) {
        if (fromState !== loopingStateRowNum) {
          loopingStateRowNum = fromState;
          loopingState = tst[loopingStateRowNum];
        }
        state[N] &= toShort(ALL_FLAGS);
        for (let j = 0; j < state.length; j++) {
          if (state[j] === 0) state[j] = loopingState[j];
          else if (state[j] === DONT_LOOP_FLAG) state[j] = 0;
        }
      }
    }
  }

  finishBuildingStateTable(forward) {
    const N = this.numCategories;
    this.backfillLoopingStates();
    const tst = this.tempStateTable;
    const rowNumMap = new Int32Array(tst.length);
    const rowsToFollow = [1];
    rowNumMap[1] = 1;
    while (rowsToFollow.length !== 0) {
      const row = tst[rowsToFollow.pop()];
      for (let i = 0; i < N; i++) {
        if (row[i] !== 0 && rowNumMap[row[i]] === 0) {
          rowNumMap[row[i]] = row[i];
          rowsToFollow.push(row[i]);
        }
      }
    }
    const stateClasses = new Int32Array(tst.length);
    let nextClass = N + 1;
    for (let i = 1; i < stateClasses.length; i++) {
      if (rowNumMap[i] === 0) continue;
      const state1 = tst[i];
      for (let j = 0; j < N; j++) if (state1[j] !== 0) ++stateClasses[i];
      if (stateClasses[i] === 0) stateClasses[i] = nextClass;
    }
    ++nextClass;
    let lastClass;
    do {
      let currentClass = 1;
      lastClass = nextClass;
      while (currentClass < nextClass) {
        let split = false, state1 = null;
        for (let i = 0; i < stateClasses.length; i++) {
          if (stateClasses[i] === currentClass) {
            if (state1 === null) state1 = tst[i];
            else {
              const state2 = tst[i];
              for (let j = 0; j < state2.length; j++) {
                if ((j === N && state1[j] !== state2[j] && forward) ||
                    (j !== N && stateClasses[state1[j]] !== stateClasses[state2[j]])) {
                  stateClasses[i] = nextClass;
                  split = true;
                  break;
                }
              }
            }
          }
        }
        if (split) ++nextClass;
        ++currentClass;
      }
    } while (lastClass !== nextClass);
    const representatives = new Int32Array(nextClass);
    for (let i = 1; i < stateClasses.length; i++) {
      if (representatives[stateClasses[i]] === 0) representatives[stateClasses[i]] = i;
      else rowNumMap[i] = representatives[stateClasses[i]];
    }
    for (let i = 1; i < rowNumMap.length; i++) if (rowNumMap[i] !== i) tst[i] = null;
    let newRowNum = 1;
    for (let i = 1; i < rowNumMap.length; i++) if (tst[i] !== null) rowNumMap[i] = newRowNum++;
    for (let i = 1; i < rowNumMap.length; i++) if (tst[i] === null) rowNumMap[i] = rowNumMap[rowNumMap[i]];
    const table = new Int16Array(newRowNum * N);
    let p = 0, p2 = 0;
    if (forward) {
      this.endStates = new Array(newRowNum).fill(false);
      this.lookaheadStates = new Array(newRowNum).fill(false);
    }
    for (let i = 0; i < tst.length; i++) {
      const row = tst[i];
      if (row === null) continue;
      for (let j = 0; j < N; j++) table[p++] = rowNumMap[row[j]];
      if (forward) {
        this.endStates[p2] = (row[N] & END_STATE_FLAG) !== 0;
        this.lookaheadStates[p2] = (row[N] & LOOKAHEAD_STATE_FLAG) !== 0;
        ++p2;
      }
    }
    if (forward) this.stateTable = table;
    else this.backwardsStateTable = table;
  }

  buildBackwardsStateTable(tempRuleList) {
    const N = this.numCategories;
    const tst = this.tempStateTable = [this.newRow(), this.newRow()];
    for (const rule of tempRuleList) if (rule[0] === '!') this.parseRule(rule.substring(1), false);
    this.backfillLoopingStates();
    let backTableOffset = tst.length;
    if (backTableOffset > 2) ++backTableOffset;
    for (let i = 0; i < N + 1; i++) tst.push(this.newRow());
    let state = tst[backTableOffset - 1];
    for (let i = 0; i < N; i++) state[i] = i + backTableOffset;
    const numRows = this.stateTable.length / N;
    for (let column = 0; column < N; column++) {
      for (let row = 0; row < numRows; row++) {
        const nextRow = this.lookupState(row, column);
        if (nextRow !== 0) {
          for (let nextColumn = 0; nextColumn < N; nextColumn++) {
            if (this.lookupState(nextRow, nextColumn) !== 0) {
              tst[nextColumn + backTableOffset][column] = column + backTableOffset;
            }
          }
        }
      }
    }
    if (backTableOffset > 1) {
      state = tst[1];
      for (let i = backTableOffset - 1; i < tst.length; i++) {
        const state2 = tst[i];
        for (let j = 0; j < N; j++) if (state[j] !== 0 && state2[j] !== 0) state2[j] = state[j];
      }
      state = tst[backTableOffset - 1];
      for (let i = 1; i < backTableOffset - 1; i++) {
        const state2 = tst[i];
        if ((state2[N] & END_STATE_FLAG) === 0) {
          for (let j = 0; j < N; j++) if (state2[j] === 0) state2[j] = state[j];
        }
      }
    }
    this.finishBuildingStateTable(false);
  }

  lookupState(state, category) { return this.stateTable[state * this.numCategories + category]; }

  makeFile(file) {
    if (this.dictionary) this.additionalData = Buffer.from(this.categoryFlags.map(f => (f ? 1 : 0)));
    const BMPdata = this.charCategoryTable.values;
    const BMPindices = this.charCategoryTable.indices;
    const nonBMPdata = this.supplementaryCharCategoryTable.dataTable;
    if (BMPdata.length <= 0) throw new Error(`Wrong BMP data length(${BMPdata.length})`);
    if (BMPindices.length !== 512) throw new Error(`Wrong BMP indices length(${BMPindices.length})`);
    if (nonBMPdata.length <= 0) throw new Error(`Wrong non-BMP data length(${nonBMPdata.length})`);
    const st = this.stateTable, bst = this.backwardsStateTable;
    const bools = a => Buffer.from(a.map(f => (f ? 1 : 0)));
    // CRC32.update(int) takes the low byte only
    const crcBytes = [];
    for (const v of st) crcBytes.push(v & 0xff);
    for (const v of bst) crcBytes.push(v & 0xff);
    for (const b of bools(this.endStates)) crcBytes.push(b);
    for (const b of bools(this.lookaheadStates)) crcBytes.push(b);
    for (const v of BMPindices) crcBytes.push(v & 0xff);
    for (const v of BMPdata) crcBytes.push(v & 0xff);
    for (const v of nonBMPdata) crcBytes.push(v & 0xff);
    if (this.additionalData) for (const v of this.additionalData) crcBytes.push(v);
    const add = this.additionalData ? this.additionalData.length : 0;
    // the length field counts a 36 byte header; the header written is 48 bytes
    const len = 36 + (st.length + bst.length) * 2 + this.endStates.length + this.lookaheadStates.length +
      1024 + BMPdata.length + nonBMPdata.length * 4 + add;
    const parts = [];
    const int = v => { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); parts.push(b); };
    const shorts = a => { const b = Buffer.alloc(a.length * 2); a.forEach((v, k) => b.writeInt16BE(toShort(v), k * 2)); parts.push(b); };
    parts.push(Buffer.from('BIdata\0\x01', 'latin1'));
    int(len); int(st.length); int(bst.length); int(this.endStates.length);
    int(this.lookaheadStates.length); int(BMPdata.length); int(nonBMPdata.length); int(add);
    const crc = Buffer.alloc(8);
    crc.writeBigUInt64BE(BigInt(crc32(crcBytes)));
    parts.push(crc);
    shorts(st);
    shorts(bst);
    parts.push(bools(this.endStates), bools(this.lookaheadStates));
    shorts(BMPindices);
    parts.push(Buffer.from(BMPdata.buffer, BMPdata.byteOffset, BMPdata.length));
    for (const v of nonBMPdata) int(v);
    if (this.additionalData) parts.push(this.additionalData);
    const out = Buffer.concat(parts);
    fs.writeFileSync(file, out);
  }
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function main(args) {
  let outputDir = '', unicodeData = 'UnicodeData.txt', language = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') outputDir = args[++i];
    else if (a === '-spec') unicodeData = args[++i];
    else if (a === '-language') language = args[++i];
    else if (a === '-country' || a === '-valiant') i++;
    else {
      process.stderr.write('Usage: GenerateBreakIteratorData [options]\n' +
        '    -o outputDir                 output directory name\n' +
        '    -spec specname               unicode text filename\n' +
        '  and locale data:\n' +
        '    -lang language               target language name\n' +
        '    -country country             target country name\n' +
        '    -valiant valiant             target valiant name\n\n');
    }
  }
  const parser = new CharSetParser(makeCategoryMap(unicodeData));
  const srcRoot = process.env.BOOTJDK_BREAKITERATOR_SRC ||
    path.resolve(path.dirname(unicodeData), '..', '..', '..', '..');
  const bundle = name => language.length > 0
    ? path.join(srcRoot, 'jdk.localedata/share/classes/sun/text/resources/ext', `${name}_${language}.java`)
    : path.join(srcRoot, 'java.base/share/classes/sun/text/resources', `${name}.java`);
  const info = readBundle(bundle('BreakIteratorInfo'));
  const rules = readBundle(bundle('BreakIteratorRules'));
  const classNames = info.get('BreakIteratorClasses');
  if (outputDir !== '') fs.mkdirSync(outputDir, { recursive: true });
  const generate = (datafile, ruleKey, builder) => {
    const rule = rules.get(ruleKey);
    if (rule === undefined) throw new Error(`Can't find resource for bundle, key ${ruleKey}`);
    if (builder !== 'RuleBasedBreakIterator' && builder !== 'DictionaryBasedBreakIterator') {
      throw new Error(`Invalid break iterator class "${builder}"`);
    }
    const bld = new RuleBasedBreakIteratorBuilder(rule, parser, builder === 'DictionaryBasedBreakIterator');
    bld.makeFile(outputDir === '' ? datafile : path.join(outputDir, datafile));
  };
  if (info.has('WordData')) generate(info.get('WordData'), 'WordBreakRules', classNames[0]);
  if (info.has('LineData')) generate(info.get('LineData'), 'LineBreakRules', classNames[1]);
  if (info.has('SentenceData')) generate(info.get('SentenceData'), 'SentenceBreakRules', classNames[2]);
  return 0;
}

module.exports = { main, JHashtable, CharSet, CharSetParser };
