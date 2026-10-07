'use strict';
// Port of make/jdk/src/classes/build/tools/charsetmapping (Main, SBCS, DBCS,
// HKSCS, EUC_TW, JIS0213, SPI, SRC, Hasher, Utils): generates the sun.nio.cs
// and sun.nio.cs.ext charset classes, StandardCharsets/ExtendedCharsets and
// sjis0213.dat from make/data/charsetmapping.
//
// usage: charsetmapping src dst stdcs|extcs charsets os template extsrc copyright
//        charsetmapping src dst hkscs copyrightfile
//        charsetmapping in.map out.dat sjis0213
const fs = require('fs');
const path = require('path');
const { LNSEP, javaTrim, splitLines } = require('./util');

const UNMAPPABLE_DECODING = 0xFFFD;
const UNMAPPABLE_ENCODING = 0xFFFD;

// java.util.Formatter subset: %s %d %x %X %b %n %% with flags/width
function jfmt(f, ...args) {
  let ai = 0;
  return f.replace(/%([-0]*)(\d*)([sdxXbn%])/g, (all, flags, width, conv) => {
    if (conv === 'n') return LNSEP;
    if (conv === '%') return '%';
    const v = args[ai++];
    let s;
    if (conv === 's') s = v === null || v === undefined ? 'null' : String(v);
    else if (conv === 'b') s = v === null || v === undefined ? 'false' : String(!!v);
    else if (conv === 'd') s = String(v);
    else { s = (v >>> 0).toString(16); if (conv === 'X') s = s.toUpperCase(); }
    if (width && s.length < +width) {
      const pad = (flags.includes('0') ? '0' : ' ').repeat(+width - s.length);
      s = flags.includes('-') ? s + pad : pad + s;
    }
    return s;
  });
}

const rep = (s, a, b) => s.split(a).join(b);

// String.hashCode
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// --- Utils ---------------------------------------------------------------

// Java regexes use possessive quantifiers; (?=(X))\k emulates them
const HEX = '(?=([0-9a-fA-F]+))\\';
const WS = '[ \\t\\n\\x0B\\f\\r]';
function pat(parts, groups) {
  // numbers are possessive hex groups (Java group index), 'WS++' possessive \s++
  let src = '^', n = 0;
  const map = [0];
  for (const p of parts) {
    if (typeof p === 'number') {
      n++; map[p] = n;
      src += `${HEX}${n}`;
    } else if (p === 'WS++') {
      n++; src += `(?=(${WS}+))\\${n}`;
    } else src += p;
  }
  return { re: new RegExp(src), map, groups };
}
const SBMAP = pat(['0x', 1, 'WS++', '(?:U\\+|0x)?', 2, `(?:${WS}+#.*)?`], 2);
const DBMAP = pat(['(?:0x)?', 1, 'WS++', '(?:0x)?', 2, `(?:${WS}+#.*)?`], 2);
const SJIS0213 = pat(['0x', 1, 'WS++', 'U\\+', 2, '(?:\\+', 3, ')?', 'WS++', '#.*'], 3);
// patterns with optional hex groups are spelled out by hand
const HKSCS_RE = {
  re: new RegExp('^(?=((?:0x)?))\\1(?=([0-9a-fA-F]+))\\2(?=(' + WS + '+))\\3(?=((?:0x|U\\+)?))\\4' +
    '(?:(?=([0-9a-fA-F]+))\\5)?(?=(' + WS + '*))\\6(?:0x|U\\+)?(?:(?=([0-9a-fA-F]+))\\7)?(?=(' + WS + '*))\\8'),
  map: [0, 2, 5, 7], groups: 3,
};
const EUCTW_RE = {
  re: new RegExp('^(?:8ea)?(?=([0-9a-fA-F]+))\\1(?=(' + WS + '+))\\2(?:(?=([0-9a-fA-F]+))\\3)?(?=(' + WS + '*))\\4'),
  map: [0, 1, 3], groups: 2,
};

// BufferedReader.readLine
function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Utils.Parser: entries {bs, cp, cp2} for every line matching p at its start
function* parse(file, p) {
  for (const line of readLines(file)) {
    if (line.startsWith('#')) continue;
    const m = p.re.exec(line);
    if (!m) continue;
    const g = (i) => m[p.map[i]];
    const e = { bs: parseHex(g(1)), cp: parseHex(g(2)), cp2: 0 };
    if (3 <= p.groups && g(3) !== undefined) e.cp2 = parseHex(g(3));
    yield e;
  }
}
function parseHex(s) {
  if (s === undefined) throw new Error('java.lang.NumberFormatException: Cannot parse null string: null');
  const v = parseInt(s, 16);
  if (v > 0x7fffffff) throw new Error(`java.lang.NumberFormatException: For input string: "${s}" under radix 16`);
  return v;
}

// Utils.Output over a StringBuilder
class Output {
  constructor() { this.sb = ''; }
  format(f, ...args) { this.sb += jfmt(f, ...args); }
  toChar(f, c) {
    switch (c) {
      case 8: this.sb += '\\b'; break;
      case 9: this.sb += '\\t'; break;
      case 10: this.sb += '\\n'; break;
      case 12: this.sb += '\\f'; break;
      case 13: this.sb += '\\r'; break;
      case 34: this.sb += '\\"'; break;
      case 39: this.sb += "\\'"; break;
      case 92: this.sb += '\\\\'; break;
      default: this.sb += jfmt(f, c & 0xffff);
    }
  }
  chars(cc, off, end, closure) {
    while (off < end) {
      this.format('        "');
      for (let j = 0; j < 8; j++) {
        if (off === end) break;
        this.toChar('\\u%04X', cc[off++]);
      }
      if (off === end) this.format('" %s%n', closure);
      else this.format('" + %n');
    }
  }
  row(db, b1, b2Min, b2Max, closure) {
    const cc = [];
    for (let b2 = b2Min; b2 <= b2Max; b2++) cc.push(db[(b1 << 8) | b2]);
    this.chars(cc, 0, cc.length, closure);
  }
  charList(date) {
    let off = 0;
    const end = date.length;
    while (off < end) {
      this.format('        ');
      for (let j = 0; j < 8 && off < end; j++) this.toChar("'\\u%04X',", date[off++]);
      this.format('%n');
    }
  }
}

function getCopyright(f) {
  let sb = '';
  for (const ln of splitLines(fs.readFileSync(f, 'latin1'))) {
    sb += ln + '\n';
    if (/^[ \t\n\x0B\f\r]\*\/$/.test(ln)) break;
  }
  return sb;
}

// Scanner(File).nextLine over a template, PrintStream.println into out
function scanLines(file) { return splitLines(fs.readFileSync(file, 'utf8')); }
const fill = (n, v) => new Array(n).fill(v);

// --- SRC -----------------------------------------------------------------

function genSRC(cs, srcDir, dstDir) {
  let out = '';
  for (const line of scanLines(path.join(srcDir, cs.clzName + '.java.template'))) {
    if (line.indexOf('$') < 0) { out += line + LNSEP; continue; }
    if (line.indexOf('$PACKAGE$') !== -1) out += rep(line, '$PACKAGE$', cs.pkgName) + LNSEP;
    else if (line.indexOf('$ALIASES$') !== -1) {
      out += rep(line, '$ALIASES$', cs.pkgName === 'sun.nio.cs'
        ? 'StandardCharsets.aliases_' + cs.clzName + '()'
        : 'ExtendedCharsets.aliasesFor("' + cs.csName + '")') + LNSEP;
    } else out += line + LNSEP;
  }
  fs.writeFileSync(path.join(dstDir, cs.clzName + '.java'), out, 'utf8');
}

// --- SBCS ----------------------------------------------------------------

function sbToString(sb, off, end, o, closure, comment) {
  while (off < end) {
    o.format('        "');
    for (let j = 0; j < 8; j++) {
      if (off === end) break;
      o.toChar('\\u%04X', sb[off++]);
    }
    if (comment) {
      if (off === end) o.format('" %s      // 0x%02x - 0x%02x%n', closure, off - 8, off - 1);
      else o.format('" +      // 0x%02x - 0x%02x%n', off - 8, off - 1);
    } else if (off === end) o.format('"%s%n', closure);
    else o.format('" +%n');
  }
}

function checkIndex(a, i) {
  if (i < 0 || i >= a.length) throw new Error(`java.lang.ArrayIndexOutOfBoundsException: Index ${i} out of bounds for length ${a.length}`);
  return i;
}

function genSBCS(cs, srcDir, dstDir, template) {
  const { clzName, csName, histName, pkgName, isASCII } = cs;
  let isLatin1Decodable = true;
  const sb = fill(0x100, UNMAPPABLE_DECODING);
  const c2bIndex = fill(0x100, UNMAPPABLE_DECODING);
  let c2bOff = 0;

  for (const e of parse(path.join(srcDir, clzName + '.map'), SBMAP)) {
    sb[checkIndex(sb, e.bs)] = e.cp & 0xffff;
    if (c2bIndex[checkIndex(c2bIndex, e.cp >> 8)] === UNMAPPABLE_DECODING) {
      c2bOff += 0x100;
      c2bIndex[e.cp >> 8] = 1;
    }
    if (e.cp > 0xFF) isLatin1Decodable = false;
  }
  let o = new Output();
  o.format('%n');
  sbToString(sb, 0x80, 0x100, o, '+', true);
  sbToString(sb, 0x00, 0x80, o, ';', true);
  const b2c = o.sb;

  let b2cNR = '';
  let f = path.join(srcDir, clzName + '.nr');
  if (fs.existsSync(f)) {
    o = new Output();
    o.format('// remove non-roundtrip entries%n');
    o.format('        b2cMap = b2cTable.toCharArray();%n');
    for (const e of parse(f, SBMAP)) {
      o.format('        b2cMap[%d] = UNMAPPABLE_DECODING;%n', e.bs >= 0x80 ? e.bs - 0x80 : e.bs + 0x80);
    }
    b2cNR = o.sb;
  }

  let c2bNR = '';
  f = path.join(srcDir, clzName + '.c2b');
  if (fs.existsSync(f)) {
    o = new Output();
    const es = [];
    for (const e of parse(f, SBMAP)) {
      if (c2bIndex[checkIndex(c2bIndex, e.cp >> 8)] === UNMAPPABLE_DECODING) {
        c2bOff += 0x100;
        c2bIndex[e.cp >> 8] = 1;
      }
      es.push(e);
    }
    o.format('// non-roundtrip c2b only entries%n');
    if (es.length < 100) {
      o.format('        c2bNR = new char[%d];%n', es.length * 2);
      let i = 0;
      for (const e of es) {
        o.format('        c2bNR[%d] = 0x%x; c2bNR[%d] = 0x%x;%n', i, e.bs, i + 1, e.cp);
        i += 2;
      }
    } else {
      const cc = [];
      for (const e of es) cc.push(e.bs & 0xffff, e.cp & 0xffff);
      o.format('        c2bNR = (%n');
      sbToString(cc, 0, cc.length, o, ').toCharArray();', false);
    }
    c2bNR = o.sb;
  }

  let out = '';
  for (let line of scanLines(path.join(srcDir, template))) {
    const i = line.indexOf('$');
    if (i === -1) { out += line + LNSEP; continue; }
    if (line.indexOf('$PACKAGE$', i) !== -1) line = rep(line, '$PACKAGE$', String(pkgName));
    if (line.indexOf('$NAME_CLZ$', i) !== -1) line = rep(line, '$NAME_CLZ$', clzName);
    if (line.indexOf('$NAME_CS$', i) !== -1) line = rep(line, '$NAME_CS$', csName);
    if (line.indexOf('$NAME_ALIASES$', i) !== -1) {
      line = rep(line, '$NAME_ALIASES$', pkgName === 'sun.nio.cs'
        ? 'StandardCharsets.aliases_' + clzName + '()'
        : 'ExtendedCharsets.aliasesFor("' + csName + '")');
    }
    if (line.indexOf('$NAME_HIST$', i) !== -1) {
      if (histName === null) throw new Error('java.lang.NullPointerException');
      line = rep(line, '$NAME_HIST$', histName);
    }
    if (line.indexOf('$CONTAINS$', i) !== -1) {
      line = isASCII
        ? '        return ((cs.name().equals("US-ASCII")) || (cs instanceof ' + clzName + '));'
        : '        return (cs instanceof ' + clzName + ');';
    }
    if (line.indexOf('$ASCIICOMPATIBLE$') !== -1) line = rep(line, '$ASCIICOMPATIBLE$', String(isASCII));
    if (line.indexOf('$LATIN1DECODABLE$') !== -1) line = rep(line, '$LATIN1DECODABLE$', String(isLatin1Decodable));
    if (line.indexOf('$B2CTABLE$') !== -1) line = rep(line, '$B2CTABLE$', b2c);
    if (line.indexOf('$C2BLENGTH$') !== -1) line = rep(line, '$C2BLENGTH$', '0x' + c2bOff.toString(16));
    if (line.indexOf('$NONROUNDTRIP_B2C$') !== -1) {
      if (b2cNR.length === 0) continue;
      line = rep(line, '$NONROUNDTRIP_B2C$', b2cNR);
    }
    if (line.indexOf('$NONROUNDTRIP_C2B$') !== -1) {
      if (c2bNR.length === 0) continue;
      line = rep(line, '$NONROUNDTRIP_C2B$', c2bNR);
    }
    out += line + LNSEP;
  }
  fs.writeFileSync(path.join(dstDir, clzName + '.java'), out, 'utf8');
}

// --- DBCS ----------------------------------------------------------------

function genDBCS(type, cs, srcDir, dstDir, template) {
  const { clzName, csName, pkgName, isASCII, b1Min, b1Max, b2Min, b2Max } = cs;
  let histName = cs.histName;
  const db = fill(0x10000, UNMAPPABLE_DECODING);
  const c2bIndex = fill(0x100, UNMAPPABLE_DECODING);
  const b2cIndex = fill(0x100, UNMAPPABLE_DECODING);
  let c2bOff = 0x100;

  for (const e of parse(path.join(srcDir, clzName + '.map'), DBMAP)) {
    db[checkIndex(db, e.bs)] = e.cp & 0xffff;
    if (e.bs > 0x100 && b2cIndex[e.bs >> 8] === UNMAPPABLE_DECODING) b2cIndex[e.bs >> 8] = 1;
    if (c2bIndex[checkIndex(c2bIndex, e.cp >> 8)] === UNMAPPABLE_DECODING) {
      c2bOff += 0x100;
      c2bIndex[e.cp >> 8] = 1;
    }
  }
  let o = new Output();
  o.format('%n    static final String b2cSBStr =%n');
  o.row(db, 0x00, 0x00, 0xff, ';');  // format(db, 0x00, 0x100, ";") = char[] slice 0..0x100
  o.format('%n        static final String[] b2cStr = {%n');
  for (let i = 0; i < 0x100; i++) {
    if (b2cIndex[i] === UNMAPPABLE_DECODING) o.format('            null,%n');
    else o.row(db, i, b2Min, b2Max, ',');
  }
  o.format('        };%n');
  const b2c = o.sb;

  const nrPairs = (f, c2b) => {
    const nr = [];
    for (const e of parse(f, DBMAP)) {
      if (c2b && c2bIndex[checkIndex(c2bIndex, e.cp >> 8)] === UNMAPPABLE_DECODING) {
        c2bOff += 0x100;
        c2bIndex[e.cp >> 8] = 1;
      }
      nr.push(e.bs & 0xffff, e.cp & 0xffff);
    }
    return nr;
  };
  let b2cNR, c2bNR;
  let f = path.join(srcDir, clzName + '.nr');
  if (fs.existsSync(f)) {
    const nr = nrPairs(f, false);
    o = new Output();
    o.format('String b2cNR =%n');
    o.chars(nr, 0, nr.length, ';');
    b2cNR = o.sb;
  } else b2cNR = 'String b2cNR = null;';
  f = path.join(srcDir, clzName + '.c2b');
  if (fs.existsSync(f)) {
    const nr = nrPairs(f, true);
    o = new Output();
    o.format('String c2bNR =%n');
    o.chars(nr, 0, nr.length, ';');
    c2bNR = o.sb;
  } else c2bNR = 'String c2bNR = null;';

  if (histName === null) histName = '';
  let c2bRepl = '';
  if (clzName.startsWith('JIS_X_0208')) c2bRepl = 'new byte[]{ (byte)0x21, (byte)0x29 },';
  else if (clzName.startsWith('JIS_X_0212')) c2bRepl = 'new byte[]{ (byte)0x22, (byte)0x44 },';
  else if (clzName.startsWith('IBM300')) c2bRepl = 'new byte[]{ (byte)0x42, (byte)0x6f },';

  let out = '';
  for (let line of scanLines(path.join(srcDir, template))) {
    if (line.indexOf('$') === -1) { out += line + LNSEP; continue; }
    const subs = [
      ['$PACKAGE$', String(pkgName)],
      ['$IMPLEMENTS$', 'implements HistoricallyNamedCharset'],
      ['$NAME_CLZ$', clzName],
      ['$NAME_ALIASES$', pkgName === 'sun.nio.cs'
        ? 'StandardCharsets.aliases_' + clzName + '()'
        : 'ExtendedCharsets.aliasesFor("' + csName + '")'],
      ['$NAME_CS$', csName],
      ['$CONTAINS$', clzName === 'MS932'
        ? 'return ((cs.name().equals("US-ASCII")) || (cs instanceof JIS_X_0201) || (cs instanceof ' + clzName + '));'
        : isASCII
          ? 'return ((cs.name().equals("US-ASCII")) || (cs instanceof ' + clzName + '));'
          : 'return (cs instanceof ' + clzName + ');'],
      ['$HISTORICALNAME$', '    public String historicalName() { return "' + histName + '"; }'],
      ['$DECTYPE$', type],
      ['$ENCTYPE$', type],
      ['$B1MIN$', '0x' + b1Min.toString(16)],
      ['$B1MAX$', '0x' + b1Max.toString(16)],
      ['$B2MIN$', '0x' + b2Min.toString(16)],
      ['$B2MAX$', '0x' + b2Max.toString(16)],
      ['$ASCIICOMPATIBLE$', String(isASCII)],
      ['$B2C$', b2c],
      ['$C2BLENGTH$', '0x' + c2bOff.toString(16)],
      ['$NONROUNDTRIP_B2C$', b2cNR],
      ['$NONROUNDTRIP_C2B$', c2bNR],
      ['$ENC_REPLACEMENT$', c2bRepl],
    ];
    for (const [a, b] of subs) line = rep(line, a, b);
    out += line + LNSEP;
  }
  fs.writeFileSync(path.join(dstDir, clzName + '.java'), out, 'utf8');
}

// --- HKSCS ---------------------------------------------------------------

function hkscsClass0(b2cFile, c2bFile, outFile, pkgName, clzName, isPublic, copyright) {
  fs.writeFileSync(outFile, '');
  const b2Min = 0x40, b2Max = 0xfe;
  try {
    const bmp = fill(0x10000, UNMAPPABLE_DECODING);
    const supp = fill(0x10000, UNMAPPABLE_DECODING);
    const b2cBmp = fill(0x100, false);
    const b2cSupp = fill(0x100, false);
    const pua = fill(0xF93b - 0xE000 + 1, UNMAPPABLE_DECODING);
    let hasSupp = false, hasPua = false;
    for (const e of parse(b2cFile, HKSCS_RE)) {
      if (e.cp >= 0x10000) {
        supp[checkIndex(supp, e.bs)] = e.cp & 0xffff;
        b2cSupp[e.bs >> 8] = true;
        hasSupp = true;
      } else {
        bmp[checkIndex(bmp, e.bs)] = e.cp;
        b2cBmp[e.bs >> 8] = true;
      }
      if (e.cp2 !== 0 && e.cp2 >= 0xe000 && e.cp2 <= 0xf8ff) {
        hasPua = true;
        pua[e.cp2 - 0xE000] = e.bs & 0xffff;
      }
    }
    if (c2bFile !== null) {
      for (const e of parse(c2bFile, HKSCS_RE)) pua[checkIndex(pua, e.cp - 0xE000)] = e.bs & 0xffff;
      hasPua = true;
    }
    const pub = isPublic ? 'public ' : '';
    const o = new Output();
    o.format(copyright);
    o.format('%n// -- This file was mechanically generated: Do not edit! -- //%n');
    o.format('package %s;%n%n', pkgName);
    o.format('%sclass %s {%n%n', pub, clzName);
    o.format('%n    %sstatic final String[] b2cBmpStr = new String[] {%n', pub);
    for (let i = 0; i < 0x100; i++) {
      if (b2cBmp[i]) o.row(bmp, i, b2Min, b2Max, ',');
      else o.format('        null,%n');
    }
    o.format('        };%n');
    o.format('%n    %sstatic final String[] b2cSuppStr =', pub);
    if (hasSupp) {
      o.format(' new String[] {%n');
      for (let i = 0; i < 0x100; i++) {
        if (b2cSupp[i]) o.row(supp, i, b2Min, b2Max, ',');
        else o.format('        null,%n');
      }
      o.format('        };%n');
    } else o.format(' null;%n');
    o.format('%n    %sfinal static String pua =', pub);
    if (hasPua) {
      o.format('%n');
      o.chars(pua, 0, pua.length, ';');
    } else o.format(' null;%n');
    o.format('%n');
    o.format('}');
    fs.writeFileSync(outFile, o.sb + LNSEP, 'latin1');
  } catch (x) {
    process.stderr.write(String(x && x.stack || x) + LNSEP);
  }
}

// --- EUC_TW --------------------------------------------------------------

function initC2BIndex(index) {
  let off = 0;
  for (let i = 0; i < index.length; i++) {
    if (index[i] !== 0) { index[i] = off & 0xffff; off += 0x100; } else index[i] = UNMAPPABLE_ENCODING;
  }
  return off;
}

function genEUC_TW(pkg, args) {
  const mapFile = path.join(args[0], 'EUC_TW.map');
  if (!fs.existsSync(mapFile)) throw new Error(`java.io.FileNotFoundException: ${mapFile}`);
  const outFile = path.join(args[1], 'EUC_TWMapping.java');
  fs.writeFileSync(outFile, '');
  const copyright = getCopyright(path.join(args[7], 'EUC_TW.java'));
  const b1Min = 0xa1, b1Max = 0xfe, b2Min = 0xa1, b2Max = 0xfe;
  try {
    const db = [];
    for (let i = 0; i < 8; i++) db.push(fill(0x10000, UNMAPPABLE_DECODING));
    const suppFlag = new Uint8Array(0x10000);
    const indexC2B = fill(256, 0);
    const indexC2BSupp = fill(256, 0);
    for (const e of parse(mapFile, EUCTW_RE)) {
      let plane = 0;
      if (e.bs >= 0x10000) {
        plane = ((e.bs >> 16) & 0xff) - 1;
        if (plane >= 14) plane = 7;
        e.bs &= 0xffff;
      }
      checkIndex(db, plane);
      db[plane][checkIndex(db[plane], e.bs)] = e.cp;
      if (e.cp < 0x10000) indexC2B[checkIndex(indexC2B, e.cp >> 8)] = 1;
      else {
        indexC2BSupp[(e.cp & 0xffff) >> 8] = 1;
        suppFlag[e.bs] |= (1 << plane) & 0xff;
      }
    }
    const intChars = (a) => {
      const ca = [];
      for (let b1 = b1Min; b1 <= b1Max; b1++)
        for (let b2 = b2Min; b2 <= b2Max; b2++) ca.push(a[b1 * 256 + b2] & 0xffff);
      return ca;
    };
    const byteChars = (ba) => {
      const ca = [];
      for (let b1 = b1Min; b1 <= b1Max; b1++)
        for (let b2 = b2Min; b2 <= b2Max; b2 += 2) ca.push((ba[b1 * 256 + b2] << 8) | ba[b1 * 256 + b2 + 1]);
      // Java sizes the array for every b2, leaving the tail as '\0'
      while (ca.length < (b1Max - b1Min + 1) * (b2Max - b2Min + 1)) ca.push(0);
      return ca;
    };
    const o = new Output();
    o.format(copyright);
    o.format('%n// -- This file was mechanically generated: Do not edit! -- //%n');
    o.format('package %s;%n%n', pkg);
    o.format('class EUC_TWMapping {%n%n');
    o.format('    final static int b1Min = 0x%x;%n', b1Min);
    o.format('    final static int b1Max = 0x%x;%n', b1Max);
    o.format('    final static int b2Min = 0x%x;%n', b2Min);
    o.format('    final static int b2Max = 0x%x;%n', b2Max);
    o.format('%n    final static String[] b2c = {%n');
    for (let plane = 0; plane < 8; plane++) {
      o.format('        // Plane %d%n', plane);
      const cc = intChars(db[plane]);
      o.chars(cc, 0, cc.length, ',');
      o.format('%n');
    }
    o.format('    };%n');
    o.format('%n    static final int C2BSIZE = 0x%x;%n', initC2BIndex(indexC2B));
    o.format('%n    static char[] c2bIndex = new char[] {%n');
    o.charList(indexC2B);
    o.format('    };%n');
    o.format('%n    static final int C2BSUPPSIZE = 0x%x;%n', initC2BIndex(indexC2BSupp));
    o.format('%n    static char[] c2bSuppIndex = new char[] {%n');
    o.charList(indexC2BSupp);
    o.format('    };%n');
    o.format('%n    static String b2cIsSuppStr =%n');
    const sf = byteChars(suppFlag);
    o.chars(sf, 0, sf.length, ';');
    o.format('}');
    fs.writeFileSync(outFile, o.sb + LNSEP, 'latin1');
  } catch (x) {
    process.stderr.write(String(x && x.stack || x) + LNSEP);
  }
}

// --- JIS0213 -------------------------------------------------------------

function genJIS0213(argv) {
  if (!fs.existsSync(argv[0])) throw new Error(`java.io.FileNotFoundException: ${argv[0]}`);
  fs.writeFileSync(argv[1], '');
  const sb = fill(0x100, 0), db = fill(0x10000, UNMAPPABLE_DECODING);
  const indexC2B = fill(256, 0);
  const supp = [], comp = [];
  for (let i = 0; i < 0x80; i++) sb[i] = i;
  for (let i = 0x80; i < 0x100; i++) sb[i] = UNMAPPABLE_DECODING;
  try {
    for (const e of parse(argv[0], SJIS0213)) {
      if (e.cp2 !== 0) {
        checkIndex(fill(0x100, 0), comp.length);
        comp.push(e);
      } else if (e.cp <= 0xffff) {
        if (e.bs <= 0xff) sb[e.bs] = e.cp;
        else db[checkIndex(db, e.bs)] = e.cp;
        indexC2B[e.cp >> 8] = 1;
      } else supp.push(e);
    }
    const bytes = [];
    const w = (d) => bytes.push((d >>> 8) & 0xff, d & 0xff);
    // INDEXC2B
    w(0x8); w(indexC2B.length);
    let off = 0;
    for (const v of indexC2B) { if (v !== 0) { w(off); off += 256; } else w(-1); }
    // SINGLEBYTE
    w(0x1); w(256);
    for (let i = 0; i < 256; i++) w(sb[i]);
    const dbl = (type, b1Min, b1Max, b2Min, b2Max) => {
      w(type); w(b1Min); w(b1Max); w(b2Min); w(b2Max);
      w((b1Max - b1Min + 1) * (b2Max - b2Min + 1));
      for (let b1 = b1Min; b1 <= b1Max; b1++)
        for (let b2 = b2Min; b2 <= b2Max; b2++) w(db[b1 * 256 + b2]);
    };
    dbl(0x2, 0x81, 0x9f, 0x40, 0xfe);
    dbl(0x3, 0xe0, 0xfc, 0x40, 0xfe);
    // SUPPLEMENT + c2b
    w(0x5); w(supp.length * 2);
    for (const e of supp) w(e.bs);
    for (const e of supp) w(e.cp);
    w(0x6); w(supp.length * 2);
    supp.sort((a, b) => a.cp - b.cp);
    for (const e of supp) w(e.cp);
    for (const e of supp) w(e.bs);
    // COMPOSITE
    w(0x7); w(comp.length * 3);
    for (const e of comp) { w(e.bs & 0xffff); w(e.cp & 0xffff); w(e.cp2 & 0xffff); }
    const n = bytes.length;
    const head = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    fs.writeFileSync(argv[1], Buffer.from(head.concat(bytes)));
  } catch (x) {
    process.stderr.write(String(x && x.stack || x) + LNSEP);
  }
}

// --- Hasher --------------------------------------------------------------

function hasherGenClass(keys, values, cln, vtype, maxBits, maxDepth, inner, empty) {
  let ht, mask, shift;
  const hash = (w) => (hashCode(w) >> shift) & mask;
  const build = (nb, s) => {
    shift = s;
    const n = 1 << nb;
    mask = n - 1;
    ht = fill(n, null);
    keys.forEach((w, i) => {
      const h = hash(w);
      ht[h] = ht[h] === null ? [w, values[i]] : [w, values[i], ht[h]];
    });
    let md = 0;
    for (let i = 0; i < n; i++) {
      let d = 1;
      for (let a = ht[i]; a !== null && a.length > 2; a = a[2], d++);
      md = Math.max(md, d);
    }
    return md;
  };
  let ok = false;
  outer: for (let nb = 2; nb < maxBits; nb++) {
    for (let s = 0; s < 32 - nb; s++) {
      if (build(nb, s) <= maxDepth) { ok = true; break outer; }
    }
  }
  if (!ok) throw new Error('Cannot find a suitable size within given constraints');
  keys.forEach((w, i) => {
    let a = ht[hash(w)];
    for (;;) {
      if (a[0] === w) break;
      if (a.length < 3) { a = null; break; }
      a = a[2];
    }
    if (a === null || a[1] !== values[i]) throw new Error(`Incorrect value: ${w}`);
  });

  const ind = inner ? '    ' : '';
  let out = '';
  const println = (s = '') => { out += s + LNSEP; };
  const genEntry = (a, depth) => {
    out += 'new Object[] { "' + a[0] + '", ' + (empty ? 'null' : a[1]);
    if (a.length < 3) { out += ' }'; return; }
    println(',');
    out += ind + '                     ' + '    '.repeat(depth);
    genEntry(a[2], depth + 1);
    out += ' }';
  };
  if (inner) println(ind + 'private static final class ' + cln);
  else { println(); println('public final class ' + cln); }
  println(ind + '    extends sun.util.PreHashedMap<' + vtype + '>');
  println(ind + '{');
  println();
  println(ind + '    private static final int ROWS = ' + ht.length + ';');
  println(ind + '    private static final int SIZE = ' + keys.length + ';');
  println(ind + '    private static final int SHIFT = ' + shift + ';');
  println(ind + '    private static final int MASK = 0x' + (mask >>> 0).toString(16) + ';');
  println();
  println(ind + '    ' + (inner ? 'private ' : 'public ') + cln + '() {');
  println(ind + '        super(ROWS, SIZE, SHIFT, MASK);');
  println(ind + '    }');
  println();
  println(ind + '    protected void init(Object[] ht) {');
  for (let i = 0; i < ht.length; i++) {
    if (ht[i] === null) continue;
    out += ind + '        ht[' + i + '] = ';
    genEntry(ht[i], 0);
    println(';');
  }
  println(ind + '    }');
  println();
  println(ind + '}');
  if (inner) println();
  return out;
}

// --- SPI -----------------------------------------------------------------

function genSPI(type, charsets, dstDir, template, os) {
  const lines = scanLines(template);
  const dst = path.join(dstDir, path.basename(rep(template, '.template', '')));
  let out = '';
  const printf = (f, ...a) => { out += jfmt(f, ...a); };
  const all = [...charsets.values()];
  if (type.startsWith('extcs')) {
    for (const line of lines) {
      if (line.indexOf('_CHARSETS_DEF_LIST_') === -1) { out += line + LNSEP; continue; }
      for (const cs of all) {
        if (!(cs.pkgName === 'sun.nio.cs.ext' && !cs.isInternal && (cs.os === null || cs.os === os))) continue;
        printf('        charset("%s", "%s",%n', cs.csName, cs.clzName);
        printf('                new String[] {%n');
        for (const alias of cs.aliases) printf('                    "%s",%n', alias);
        printf('                });%n%n');
      }
    }
  } else if (type.startsWith('stdcs')) {
    const aliasKeys = [], aliasValues = [], clzKeys = [], clzValues = [];
    for (const cs of all) {
      if (!(cs.pkgName === 'sun.nio.cs' && !cs.isInternal)) continue;
      let csname = cs.csName.toLowerCase();
      clzKeys.push(csname);
      clzValues.push('"' + cs.clzName + '"');
      if (cs.aliases !== null) {
        csname = '"' + csname + '"';
        for (const alias of cs.aliases) { aliasKeys.push(alias.toLowerCase()); aliasValues.push(csname); }
      }
    }
    for (const line of lines) {
      if (line.indexOf('_INCLUDE_ALIASES_TABLES_') !== -1) {
        for (const cs of all) {
          if (cs.pkgName !== 'sun.nio.cs') continue;
          if (cs.aliases === null || cs.aliases.length === 0) {
            if (cs.csName === 'GB18030') {
              printf('    static String[] aliases_GB18030() { return new String[] {%n');
              printf('            GB18030.IS_2000 ? "gb18030-2000" : "gb18030-2022"%n');
              printf('        };%n');
              printf('    }%n%n');
            } else printf('    static String[] aliases_%s() { return null; }%n%n', cs.clzName);
          } else {
            let methodEnd = true;
            if (cs.clzName === 'SJIS' || cs.clzName === 'MS932') {
              printf('    static String[] aliases_%s() { return aliases_%s; }%n%n', cs.clzName, cs.clzName);
              printf('    static String[] aliases_%s = new String[] {%n', cs.clzName);
              methodEnd = false;
            } else printf('    static String[] aliases_%s() { return new String[] {%n', cs.clzName);
            for (const alias of cs.aliases) printf('            "%s",%n', alias);
            printf('        };%n%n');
            if (methodEnd) printf('    }%n%n');
          }
        }
        const cs = charsets.get('SJIS');
        if (cs === undefined || cs.pkgName === 'sun.nio.cs.ext') {
          printf('    static String[] aliases_SJIS = null;%n%n');
          printf('    static String[] aliases_MS932 = null;%n%n');
        }
      } else if (line.indexOf('_INCLUDE_ALIASES_MAP_') !== -1) {
        out += hasherGenClass(aliasKeys, aliasValues, 'Aliases', 'String', 12, 3, true, false);
      } else if (line.indexOf('_INCLUDE_CLASSES_MAP_') !== -1) {
        out += hasherGenClass(clzKeys, clzValues, 'Classes', 'String', 11, 3, true, false);
      } else if (line.indexOf('_INCLUDE_CACHE_MAP_') !== -1) {
        out += hasherGenClass(clzKeys, clzValues, 'Cache', 'Charset', 11, 3, true, true);
      } else out += line + LNSEP;
    }
  } else throw new Error('Unknown type:' + type);
  fs.writeFileSync(dst, out, 'utf8');
}

// --- Main ----------------------------------------------------------------

function toInteger(s) {
  const hex = s.startsWith('0x') || s.startsWith('0X');
  const t = hex ? s.slice(2) : s;
  if (!(hex ? /^[+-]?[0-9a-fA-F]+$/ : /^[+-]?[0-9]+$/).test(t)) {
    throw new Error(`java.lang.NumberFormatException: For input string: "${t}"`);
  }
  return parseInt(t, hex ? 16 : 10);
}

const parseBoolean = (s) => s !== undefined && s.toLowerCase() === 'true';

function getCharsets(file) {
  const charsets = new Map();
  let cs = null;
  let names = [];
  for (const line of scanLines(file)) {
    if (line.startsWith('#') || line.length === 0) continue;
    const tokens = line.split(/[ \t\n\x0B\f\r]+/);
    while (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
    if (tokens.length < 2) continue;
    if (tokens[0] === 'charset') {
      if (cs !== null) {
        cs.aliases = names.slice();
        charsets.set(cs.clzName, cs);
        cs = null;
        names = [];
      }
      if (tokens.length < 3) throw new Error('Error: incorrect charset line [' + line + ']');
      if (charsets.has(tokens[2])) throw new Error('Error: duplicate charset line [' + line + ']');
      cs = {
        pkgName: null, clzName: tokens[2], csName: tokens[1], histName: null, type: null, os: null,
        isASCII: false, b1Min: 0, b1Max: 0, b2Min: 0, b2Max: 0, aliases: null, isInternal: false,
      };
    } else {
      switch (tokens[1]) {
        case 'alias':
          if (tokens.length < 3) throw new Error('Error: incorrect alias line [' + line + ']');
          names.push(tokens[2]);
          break;
        case 'package': cs.pkgName = tokens[2]; break;
        case 'type': cs.type = tokens[2]; break;
        case 'os': cs.os = tokens[2]; break;
        case 'histname': cs.histName = tokens[2]; break;
        case 'ascii': cs.isASCII = parseBoolean(tokens[2]); break;
        case 'minmax':
          cs.b1Min = toInteger(tokens[2]);
          cs.b1Max = toInteger(tokens[3]);
          cs.b2Min = toInteger(tokens[4]);
          cs.b2Max = toInteger(tokens[5]);
          break;
        case 'internal': cs.isInternal = parseBoolean(tokens[2]); break;
        default:
      }
    }
  }
  if (cs !== null) {
    cs.aliases = names.slice();
    charsets.set(cs.clzName, cs);
  }
  return charsets;
}

function getOSStdCSList(file) {
  const names = [];
  if (fs.existsSync(file)) {
    for (let line of scanLines(file)) {
      const i = line.indexOf('#');
      if (i !== -1) line = line.slice(0, i);
      line = javaTrim(line);
      if (line.length !== 0) names.push(line);
    }
  }
  return names;
}

function main(args) {
  const SRC_DIR = 0, DST_DIR = 1, TYPE = 2, CHARSETS = 3, OS = 4, TEMPLATE = 5, EXT_SRC = 6, COPYRIGHT_SRC = 7;
  if (args.length < 3) {
    process.stdout.write('Usage: java -jar charsetmapping.jar src dst spiType charsets os [template]' + LNSEP);
    return 1;
  }
  const isStandard = args[TYPE] === 'stdcs';
  const isExtended = args[TYPE] === 'extcs';
  if (isStandard || isExtended) {
    const charsets = getCharsets(path.join(args[SRC_DIR], args[CHARSETS]));
    const osStdcs = getOSStdCSList(path.join(args[SRC_DIR], args[OS]));
    let hasBig5_HKSCS = false, hasMS950_HKSCS = false, hasMS950_HKSCS_XP = false, hasEUC_TW = false;
    for (const name of osStdcs) {
      const cs = charsets.get(name);
      if (cs !== undefined) cs.pkgName = 'sun.nio.cs';
      if (name === 'Big5_HKSCS') hasBig5_HKSCS = true;
      else if (name === 'MS950_HKSCS') hasMS950_HKSCS = true;
      else if (name === 'MS950_HKSCS_XP') hasMS950_HKSCS_XP = true;
      else if (name === 'EUC_TW') hasEUC_TW = true;
    }
    let log = '';
    for (const cs of charsets.values()) {
      if (isStandard && cs.pkgName === 'sun.nio.cs.ext' || isExtended && cs.pkgName === 'sun.nio.cs') continue;
      log += jfmt('%s, %s, %s, %s, %s  %b%n', cs.clzName, cs.csName, cs.histName, cs.pkgName, cs.type, cs.isASCII);
      switch (cs.type) {
        case 'template': genSRC(cs, args[EXT_SRC], args[DST_DIR]); break;
        case 'sbcs': genSBCS(cs, args[SRC_DIR], args[DST_DIR], 'SingleByte-X.java.template'); break;
        case 'source': break;
        default:
          genDBCS(cs.type === 'dbcs' ? '' : '_' + cs.type.toUpperCase(),
            cs, args[SRC_DIR], args[DST_DIR], 'DoubleByte-X.java.template');
      }
    }
    process.stdout.write(log);
    genSPI(args[TYPE], charsets, args[DST_DIR], args[TEMPLATE],
      args[OS].endsWith('windows') ? 'windows' : 'unix');
    const pkg = isStandard ? 'sun.nio.cs' : 'sun.nio.cs.ext';
    const copyright = () => getCopyright(path.join(args[COPYRIGHT_SRC], 'HKSCS.java'));
    if (isStandard && (hasBig5_HKSCS || hasMS950_HKSCS) || isExtended && !(hasBig5_HKSCS || hasMS950_HKSCS)) {
      hkscsClass0(path.join(args[SRC_DIR], 'HKSCS2008.map'), path.join(args[SRC_DIR], 'HKSCS2008.c2b'),
        path.join(args[DST_DIR], 'HKSCSMapping.java'), pkg, 'HKSCSMapping', true, copyright());
    }
    if (isStandard && hasMS950_HKSCS_XP || isExtended && !hasMS950_HKSCS_XP) {
      hkscsClass0(path.join(args[SRC_DIR], 'HKSCS_XP.map'), null,
        path.join(args[DST_DIR], 'HKSCS_XPMapping.java'), pkg, 'HKSCS_XPMapping', false, copyright());
    }
    if (isStandard && hasEUC_TW) genEUC_TW('sun.nio.cs', args);
    if (!isStandard && !hasEUC_TW) genEUC_TW('sun.nio.cs.ext', args);
  } else if (args[TYPE] === 'sjis0213') {
    genJIS0213(args);
  } else if (args[TYPE] === 'hkscs') {
    hkscsClass0(path.join(args[0], 'HKSCS2001.map'), path.join(args[0], 'HKSCS2001.c2b'),
      path.join(args[1], 'HKSCS2001Mapping.java'), 'sun.nio.cs.ext', 'HKSCS2001Mapping', false,
      getCopyright(args[3]));
  }
  return 0;
}

module.exports = { main, jfmt, hashCode, getCharsets, hasherGenClass };
