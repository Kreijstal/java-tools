'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const T = path.join(__dirname, '..', 'tools', 'bootjdk', 'tools');
const { LNSEP } = require(path.join(T, 'util'));
const extraprops = require(path.join(T, 'genextraprops'));
const specialcasing = require(path.join(T, 'genspecialcasing'));
const casefolding = require(path.join(T, 'gencasefolding'));
const gencharacter = require(path.join(T, 'gencharacter'));
const charname = require(path.join(T, 'gencharname'));
const breakiter = require(path.join(T, 'genbreakiter'));
const { deflate } = require(path.join(T, 'genchar-deflate'));
const { javaSplit } = require(path.join(T, 'genchar-common'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootjdk-chardata-'));
}
const lines = (...l) => l.map(x => x + '\n').join('');

const UNICODE_DATA = lines(
  '0009;<control>;Cc;0;S;;;;;N;CHARACTER TABULATION;;;;',
  '0024;DOLLAR SIGN;Sc;0;ET;;;;;N;;;;;',
  '0028;LEFT PARENTHESIS;Ps;0;ON;;;;;Y;OPENING PARENTHESIS;;;;',
  '0030;DIGIT ZERO;Nd;0;EN;;0;0;0;N;;;;;',
  '0041;LATIN CAPITAL LETTER A;Lu;0;L;;;;;N;;;;0061;',
  '0061;LATIN SMALL LETTER A;Ll;0;L;;;;;N;;;0041;;0041',
  '00BD;VULGAR FRACTION ONE HALF;No;0;ON;<fraction> 0031 2044 0032;;;1/2;N;FRACTION ONE HALF;;;;',
  '00DF;LATIN SMALL LETTER SHARP S;Ll;0;L;;;;;N;;;;;',
  '0130;LATIN CAPITAL LETTER I WITH DOT ABOVE;Lu;0;L;0049 0307;;;;N;;;;0069;',
  '0131;LATIN SMALL LETTER DOTLESS I;Ll;0;L;;;;;N;;;0049;;0049',
  '3400;<CJK Ideograph Extension A, First>;Lo;0;L;;;;;N;;;;;',
  '4DBF;<CJK Ideograph Extension A, Last>;Lo;0;L;;;;;N;;;;;');

test('String.split semantics', (t) => {
  t.deepEqual(javaSplit('a;b;;', /;/), ['a', 'b']);
  t.deepEqual(javaSplit('', / /), ['']);
  t.deepEqual(javaSplit(' x', / /), ['', 'x']);
  t.deepEqual(javaSplit(';;', /;/), []);
  t.end();
});

test('GenerateExtraProperties merges adjacent ranges', (t) => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'props.txt'), lines(
    '# comment', '', '0041..0043    ; Foo # x', '0044          ; Foo', '0050          ; Foo',
    '0060..0061    ; Foo', '0070          ; Bar', '0080          ; InCB; Linker'));
  fs.writeFileSync(path.join(d, 't.java'), lines('a', '  %%%Foo%%%', '%%%InCB=Linker%%%', 'b'));
  t.equal(extraprops.main([path.join(d, 't.java'), path.join(d, 'props.txt'), path.join(d, 'o.java'), 'Foo', 'InCB=Linker']), 0);
  t.equal(fs.readFileSync(path.join(d, 'o.java'), 'utf8'),
    ['a', '           (cp >= 0x0041 && cp <= 0x0044) ||\n            cp == 0x0050 ||\n' +
      '            cp == 0x0060 ||\n            cp == 0x0061;', '            cp == 0x0080;', 'b']
      .map(l => l + LNSEP).join(''));
  t.end();
});

test('GenerateSpecialCasing keeps conditional entries and U+0130', (t) => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'sc.txt'), lines(
    '# header', '00DF; 00DF; 0053 0073; 0053 0053; # SHARP S',
    '0130; 0069 0307; 0130; 0130; # I WITH DOT', '03A3; 03C2; 03A3; 03A3; Final_Sigma; # SIGMA',
    '0049; 0131; 0049; 0049; tr Not_Before_Dot; # I'));
  fs.writeFileSync(path.join(d, 't.java'), lines('{', '    %%%SpecialCasing%%%', '}'));
  t.equal(specialcasing.main([path.join(d, 't.java'), path.join(d, 'sc.txt'), path.join(d, 'o.java')]), 0);
  t.equal(fs.readFileSync(path.join(d, 'o.java'), 'utf8'), [
    '{',
    '        new Entry(0x0130, new char[]{0x0069,0x0307}, new char[]{0x0130}, "", NONE),',
    '        new Entry(0x03A3, new char[]{0x03C2}, new char[]{0x03A3}, "", FINAL_SIGMA),',
    '        new Entry(0x0049, new char[]{0x0131}, new char[]{0x0049}, "tr", NOT_BEFORE_DOT),',
    '}'].map(l => l + LNSEP).join(''));
  t.end();
});

test('GenerateCaseFolding tables', (t) => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'UnicodeData.txt'), UNICODE_DATA);
  fs.writeFileSync(path.join(d, 'CaseFolding.txt'), lines(
    '# x', '0041; C; 0061; # A', '00DF; F; 0073 0073; # SHARP S', '0130; T; 0069; # I DOT',
    '0049; T; 0131; # I'));
  fs.writeFileSync(path.join(d, 't.java'), lines('x', '%%%Entries', '%%%Expanded_Case_Map_Entries', 'y'));
  t.equal(casefolding.main([path.join(d, 't.java'), path.join(d, 'CaseFolding.txt'), path.join(d, 'o.java')]), 0);
  const out = fs.readFileSync(path.join(d, 'o.java'), 'utf8');
  t.ok(out.includes('        0X0041, 0X00DF\n'));
  t.ok(out.includes('        0x0000000000061L, 0x2000000730073L\n'));
  // 0049 -> 0131 maps back (toUpperCase(0131) == 0049) and is dropped
  t.ok(out.includes('        entry(0x0131, 0x0049),\n        entry(0x0130, 0x0069)' + LNSEP));
  t.end();
});

test('GenerateCharacter Latin-1 tables and lookups', (t) => {
  const d = tmpdir();
  // only Latin-1 entries: like the Java tool, the -latin1 map overflows otherwise
  fs.writeFileSync(path.join(d, 'UnicodeData.txt'), UNICODE_DATA.split('\n').slice(0, 8).join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'SpecialCasing.txt'), lines('00DF; 00DF; 0053 0073; 0053 0053; # SHARP S'));
  fs.writeFileSync(path.join(d, 'PropList.txt'), lines('0061          ; Other_Lowercase # x'));
  fs.writeFileSync(path.join(d, 'Derived.txt'), lines('0041..0042    ; ID_Start # x'));
  fs.writeFileSync(path.join(d, 'emoji.txt'), lines('0023 ; Emoji # x', '0024..0025 ; Emoji_Component'));
  fs.writeFileSync(path.join(d, 't.java'), lines('class X {', '$$Tables', '  int p(int ch) { return $$Lookup(ch); }',
    '  int q(int ch) { return $$LookupEx(ch) & $$maskIDStart; } // $$maskType $$UPPERCASE_LETTER', '}'));
  const common = ['-template', path.join(d, 't.java'), '-spec', path.join(d, 'UnicodeData.txt'),
    '-specialcasing', path.join(d, 'SpecialCasing.txt'), '-proplist', path.join(d, 'PropList.txt'),
    '-derivedprops', path.join(d, 'Derived.txt'), '-emojidata', path.join(d, 'emoji.txt'), '-usecharforbyte'];
  t.equal(gencharacter.main([...common, '-o', path.join(d, 'L.java'), '-latin1', '8']), 0);
  const out = fs.readFileSync(path.join(d, 'L.java'), 'utf8');
  t.ok(out.startsWith('// This file was generated AUTOMATICALLY from a template file ' + LNSEP + 'class X {' + LNSEP));
  t.ok(out.includes('  @Stable static final int A[] = {\n'));
  // entries with B bits print as Java's long arithmetic leaves them
  t.ok(out.includes('    -0xFF7D801F,  //  65   , hasUpper (subtract 479), hasTitle, otherUppercase, otherAlphabetic,'));
  t.ok(out.includes('    0x0012,  //  65   unassigned, L, otherUppercase, IDStart\n'));
  t.ok(out.includes('    0x0001,  //  97   unassigned, L, otherLowercase\n'));
  t.ok(out.includes('    0x5800400F,  //   9   Cc, S, whitespace\n'));
  t.ok(out.includes('return A[ch]; }'));
  t.ok(out.includes('return B[ch] & 0x0010; } // 0x1F 1' + LNSEP));
  t.ok(out.includes('// In all, the character property tables require 1024 bytes.'));

  t.equal(gencharacter.main([...common, '-o', path.join(d, 'P.java'), '-string', '-plane', '0', '11', '4', '1']), 0);
  const p = fs.readFileSync(path.join(d, 'P.java'), 'utf8');
  t.ok(p.includes('    @Stable static final char[][][] charMap;\n'));
  t.ok(p.includes('  static final String A_DATA =\n'));
  t.ok(p.includes('return A[Y[X[ch>>5]|((ch>>1)&0xF)]|(ch&0x1)]; }'));
  t.equal(gencharacter.formatForSource('\u0000A\u1234', '  '), '  "\\000\\101\\u1234"');
  t.end();
});

test('deflate matches zlib level 6', (t) => {
  const a = Buffer.from('hello hello hello hello, world!'.repeat(3));
  t.equal(deflate(a).toString('hex'), '789ccb48cdc9c957c840277514caf38b725214312448920600428a21d0');
  const b = Buffer.alloc(256 * 40);
  for (let i = 0; i < b.length; i++) b[i] = i & 0xff;
  const z = deflate(b);
  t.equal(z.length, 372);
  t.equal(z.subarray(0, 8).toString('hex'), '789c636064626661');
  const r = Buffer.alloc(200000);
  let x = 1;
  for (let i = 0; i < r.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; r[i] = (x >>> 16) % 7 + 97; }
  t.ok(zlib.inflateSync(deflate(r)).equals(r));
  t.ok(zlib.inflateSync(deflate(Buffer.alloc(0))).equals(Buffer.alloc(0)));
  t.end();
});

test('CharacterName writes a deflated name table', (t) => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'UnicodeData.txt'), UNICODE_DATA);
  t.equal(charname.main([path.join(d, 'UnicodeData.txt'), path.join(d, 'uniName.dat')]), 0);
  const raw = zlib.inflateSync(fs.readFileSync(path.join(d, 'uniName.dat')));
  const cpNum = raw.readInt32BE(8), nameOff = raw.readInt32BE(12);
  t.equal(cpNum, 10);
  t.equal(raw.readInt32BE(4), 2); // blocks 0x00 and 0x01
  t.equal(raw.readInt32BE(0), raw.length - 16);
  t.ok(raw.subarray(16 + nameOff).toString('latin1').startsWith('CHARACTER TABULATIONDOLLAR SIGN'));
  t.end();
});

test('Hashtable enumeration order', (t) => {
  const h = new breakiter.JHashtable();
  for (const k of ['a', 'b', 'c']) h.put(k, k);
  t.deepEqual(h.entries().map(e => e.key), ['b', 'a', 'c']);
  const big = new breakiter.JHashtable();
  for (let i = 0; i < 20; i++) big.put('k' + i, i);
  t.equal(big.table.length, 47);
  t.equal(big.get('k7'), 7);
  t.equal(big.entries().length, 20);
  t.end();
});

test('GenerateBreakIteratorData from synthetic bundles', (t) => {
  const d = tmpdir();
  const res = path.join(d, 'java.base/share/classes/sun/text/resources');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, 'BreakIteratorInfo.java'), `package x;
public class BreakIteratorInfo extends ListResourceBundle {
    protected final Object[][] getContents() {
        return new Object[][] {
            {"BreakIteratorClasses", new String[] { "RuleBasedBreakIterator", "RuleBasedBreakIterator" } },
            {"WordData", "WordBreakIteratorData"},
        };
    }
}`);
  fs.writeFileSync(path.join(res, 'BreakIteratorRules.java'), `package x;
public class BreakIteratorRules extends ListResourceBundle {
    protected final Object[][] getContents() {
        return new Object[][] {
            { "WordBreakRules",
              "<ignore>=[:Cf:];" // comment "with quotes"
              + "<let>=[:L:];"
              + "<dgt>=[:N:\\u00bd];"
              + ".;"
              + "<let><let>*;"
              + "<dgt><dgt>*;"
              + "!<let><let>*;"
            },
        };
    }
}`);
  // the bundle sources are found relative to <src>/java.base/share/data/unicodedata
  const ucd = path.join(d, 'java.base/share/data/unicodedata');
  fs.mkdirSync(ucd, { recursive: true });
  fs.writeFileSync(path.join(ucd, 'UnicodeData.txt'), UNICODE_DATA);
  t.equal(breakiter.main(['-o', path.join(d, 'out'), '-spec', path.join(ucd, 'UnicodeData.txt')]), 0);
  const b = fs.readFileSync(path.join(d, 'out', 'WordBreakIteratorData'));
  t.equal(b.subarray(0, 8).toString('latin1'), 'BIdata\0\x01');
  t.equal(b.readInt32BE(8), b.length - 12); // the length field assumes a 36 byte header
  const stateLen = b.readInt32BE(12), bmpLen = b.readInt32BE(28), nonBmpLen = b.readInt32BE(32);
  t.equal(stateLen, 15); // 5 states x 3 categories: ignored, letters, digits
  t.equal(bmpLen % 128, 0);
  t.ok(nonBmpLen >= 2);
  t.end();
});
