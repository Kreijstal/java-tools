'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cm = require(path.join(__dirname, '..', 'tools', 'bootjdk', 'tools', 'charsetmapping'));
const { LNSEP } = require(path.join(__dirname, '..', 'tools', 'bootjdk', 'tools', 'util'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootjdk-charsetmapping-'));
}

test('jfmt and String.hashCode follow Java', (t) => {
  t.equal(cm.jfmt('\\u%04X 0x%02x %s %b%n', 0xab, 5, null, true), '\\u00AB 0x05 null true' + LNSEP);
  t.equal(cm.hashCode('hello'), 99162322);
  t.equal(cm.hashCode('polygenelubricants'), -2147483648);
  t.end();
});

test('Hasher chains later keys in front and emits a PreHashedMap', (t) => {
  const out = cm.hasherGenClass(['a', 'b'], ['"A"', '"B"'], 'M', 'String', 11, 3, true, false);
  t.ok(out.includes('private static final class M' + LNSEP));
  t.ok(out.includes('ht[1] = new Object[] { "a", "A" };'));
  t.ok(out.includes('ht[2] = new Object[] { "b", "B" };'));
  t.ok(out.endsWith('    }' + LNSEP + LNSEP + '    }' + LNSEP + LNSEP));
  t.end();
});

test('sbcs charset and ExtendedCharsets from a synthetic charsets list', (t) => {
  const src = tmpdir(), dst = tmpdir();
  fs.writeFileSync(path.join(src, 'charsets'), [
    '# test',
    'charset X-TEST TEST1',
    '    package sun.nio.cs.ext',
    '    type    sbcs',
    '    histname Test1',
    '    ascii   true',
    '    alias   t1',
    '    alias   test-1',
    '',
  ].join('\n'));
  // listing these as standard keeps extcs from generating the HKSCS/EUC_TW tables
  fs.writeFileSync(path.join(src, 'stdcs-test'), 'MS950_HKSCS\nMS950_HKSCS_XP  # xp\nEUC_TW\n');
  fs.writeFileSync(path.join(src, 'TEST1.map'), '0x41 0x0041\n0x80 U+20AC # euro\n');
  fs.writeFileSync(path.join(src, 'SingleByte-X.java.template'),
    'package $PACKAGE$;\nclass $NAME_CLZ$ { // $NAME_HIST$ $LATIN1DECODABLE$ $C2BLENGTH$\n$CONTAINS$\n$NONROUNDTRIP_B2C$\n$B2CTABLE$}\n');
  const tpl = path.join(src, 'ExtendedCharsets.java.template');
  fs.writeFileSync(tpl, 'class E {\n_CHARSETS_DEF_LIST_\n}\n');
  t.equal(cm.main([src, dst, 'extcs', 'charsets', 'stdcs-test', tpl, src, src]), 0);
  const java = fs.readFileSync(path.join(dst, 'TEST1.java'), 'utf8');
  t.ok(java.startsWith('package sun.nio.cs.ext;' + LNSEP + 'class TEST1 { // Test1 false 0x200' + LNSEP));
  t.ok(java.includes('        return ((cs.name().equals("US-ASCII")) || (cs instanceof TEST1));'));
  t.notOk(java.includes('NONROUNDTRIP'));
  t.ok(java.includes('"\\u20AC\\uFFFD\\uFFFD\\uFFFD\\uFFFD\\uFFFD\\uFFFD\\uFFFD" +      // 0x80 - 0x87' + LNSEP));
  t.ok(java.includes('\\u0041'));
  t.equal(fs.readFileSync(path.join(dst, 'ExtendedCharsets.java'), 'utf8'), [
    'class E {',
    '        charset("X-TEST", "TEST1",',
    '                new String[] {',
    '                    "t1",',
    '                    "test-1",',
    '                });',
    '',
    '}', ''].join(LNSEP));
  t.end();
});

test('sjis0213 writes a size-prefixed big-endian table', (t) => {
  const dir = tmpdir();
  const map = path.join(dir, 'm.map'), dat = path.join(dir, 'o.dat');
  fs.writeFileSync(map, '0x41 U+0041 # A\n0x8140 U+3000 # sp\n0x82F5 U+304B+309A # ka\n');
  cm.main([map, dat, 'sjis0213']);
  const b = fs.readFileSync(dat);
  t.equal(b.readUInt32BE(0), b.length - 4);
  t.equal(b.readUInt16BE(4), 0x8);
  t.equal(b.readUInt16BE(6), 256);
  t.equal(b.readUInt16BE(8), 0);        // page 0x00 maps to offset 0
  t.equal(b.readUInt16BE(10), 0xffff);  // page 0x01 unused
  t.end();
});
