'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(__dirname, '..', 'tools', 'bootjdk', 'tools');
const mj = require(path.join(dir, 'misc-java'));
const fieldgen = require(path.join(dir, 'fieldgen'));
const equivmaps = require(path.join(dir, 'equivmaps'));
const vhguards = require(path.join(dir, 'varhandleguards'));
const tzdb = require(path.join(dir, 'tzdb'));
const currency = require(path.join(dir, 'currencydata'));
const javasec = require(path.join(dir, 'makejavasecurity'));
const { LNSEP } = require(path.join(dir, 'util'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootjdk-misctools-'));
}

test('HashSet iteration follows Java bucket order', (t) => {
  t.equal(mj.stringHash('polygenelubricants'), -2147483648);
  const s = new mj.JHashSet();
  for (const k of ['t10', 't2', 't1', 'b', 'a']) s.add(k);
  // buckets: a=1, t10=2 (inserted before b), b=2, t1=13, t2=14
  t.deepEqual(s.values(), ['a', 't10', 'b', 't1', 't2']);
  t.end();
});

test('Properties.load: continuations, separators, escapes, comments', (t) => {
  const p = mj.loadProperties('a=b\\\n   c\n# x\\\n k : v \\u0041\nx y z\n! c\nq\\=r=s\\\\\n');
  t.deepEqual([...p], [['a', 'bc'], ['k', 'v A'], ['x', 'y z'], ['q=r', 's\\']]);
  t.end();
});

test('DataOutput writeUTF uses modified UTF-8', (t) => {
  const o = new mj.DataOutput();
  o.writeUTF('a\u0000\u00e9');
  t.deepEqual([...o.toBuffer()], [0, 5, 0x61, 0xc0, 0x80, 0xc3, 0xa9]);
  t.end();
});

test('FieldGen splits the order subtrahend into limb terms', (t) => {
  const terms = fieldgen.buildTerms((1n << 8n) - 0xF1n, 4);
  // 15 = 16 - 1: a carried term per limb
  t.deepEqual(terms, [{ power: 0, coefficient: 1 }, { power: 4, coefficient: -1 }]);
  t.end();
});

test('EquivMapsGenerator builds single, multi and region maps', (t) => {
  const lsr = [
    'File-Date: 2024-01-01', '%%',
    'Type: language', 'Subtag: aaa', 'Preferred-Value: bbb', '%%',
    'Type: language', 'Subtag: ccc', 'Preferred-Value: ddd', '%%',
    'Type: extlang', 'Subtag: eee', 'Preferred-Value: ddd', 'Prefix: zh', '%%',
    'Type: region', 'Subtag: BU', 'Preferred-Value: MM',
  ].join('\n') + '\n';
  const out = equivmaps.generate(lsr, 2026, null);
  t.ok(out.includes('Copyright (c) 2012, 2026,'));
  t.ok(out.includes('//   LSR Revision: 2024-01-01\n'));
  t.ok(out.includes('        singleEquivMap.put("aaa", "bbb");' + LNSEP));
  t.ok(out.includes('        multiEquivsMap.put("ddd", new String[] {"ccc", "zh-eee"});' + LNSEP));
  t.ok(out.includes('        regionVariantEquivMap.put("-bu", "-mm");' + LNSEP));
  t.ok(out.endsWith('    }\n\n}\n'));
  t.end();
});

test('VarHandleGuardMethodGenerator emits distinct guard shapes', (t) => {
  const out = vhguards.generate();
  const names = out.match(/guard_\w+(?=\()/g);
  t.equal(names.length, new Set(names).size);
  t.equal(names[0], 'guard_L_L');
  t.ok(names.includes('guard_LJJ_V') && names.includes('guard_LIII_Z'));
  t.ok(out.includes('            return ad.returnType.cast(r);\n'));
  t.end();
});

test('tzdb date arithmetic matches java.time', (t) => {
  t.equal(tzdb.dateOf(1970, 1, 1), 0);
  t.equal(tzdb.dateOf(2004, 3, 1), 12478);
  t.deepEqual(tzdb.fromEpochDay(-1), { y: 1969, m: 12, d: 31 });
  t.deepEqual(tzdb.fromEpochDay(tzdb.dateOf(-999999999, 1, 1)), { y: -999999999, m: 1, d: 1 });
  t.end();
});

test('TzdbZoneRulesCompiler writes a fixed-offset zone and a link', (t) => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'VERSION'), 'tzdata2099z\n');
  fs.writeFileSync(path.join(d, 'zones'), 'Zone Etc/Test 1:00 - TST\nLink Etc/Test Etc/Alias\n');
  const dst = path.join(d, 'tzdb.dat');
  t.equal(tzdb.main(['-srcdir', d, '-dstfile', dst, 'zones']), 0);
  const b = fs.readFileSync(dst);
  const expect = Buffer.from([
    1, 0, 4, ...Buffer.from('TZDB'), 0, 1, 0, 5, ...Buffer.from('2099z'),
    0, 2, 0, 9, ...Buffer.from('Etc/Alias'), 0, 8, ...Buffer.from('Etc/Test'),
    0, 1, 0, 12, 1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 4, 0,
    0, 2, 0, 0, 0, 0, 0, 1, 0, 0,
    0, 1, 0, 0, 0, 1,
  ]);
  t.deepEqual([...b], [...expect]);
  t.end();
});

test('GenerateCurrencyData encodes simple and special countries', (t) => {
  const props = mj.loadProperties([
    'formatVersion=3', 'dataVersion=7', 'all=AAA001-BBB002-CCC003', 'minor0=BBB', 'minorUndefined=CCC',
    'AA=AAA', 'AB=BBB', 'AC=AAA;2001-01-01-00-00-00;CCC',
  ].join('\n'));
  const b = currency.generate(props);
  t.equal(b.readInt32BE(0), 0x43757244);
  t.equal(b.readInt32BE(12), 0 | (2 << 5) | (1 << 10));          // AA -> AAA
  t.equal(b.readInt32BE(16), 0x200 | 1);                           // AB -> special 0
  t.equal(b.readInt32BE(12 + 26 * 26 * 4), 2);                     // two special cases
  t.equal(b.readBigInt64BE(16 + 26 * 26 * 4), 0x7fffffffffffffffn);
  t.end();
});

test('MakeJavaSecurity filters platforms and numbers .tbd entries', (t) => {
  const lines = javasec.makeJavaSecurity([
    'package.access=sun.misc.,\\', '               sun.reflect.,\\', '',
    '#ifdef windows', 'p.tbd=w', '#else', 'p.tbd=o', '#endif',
    'p.tbd=x', 'crypto.policy=crypto.policydir-tbd',
  ], ['com.extra.'], 'windows', 'x86', 'unlimited');
  t.deepEqual(lines, [
    'package.access=sun.misc.,\\', '               sun.reflect.,\\', '               com.extra.', '',
    'p.1=w', 'p.2=x', 'crypto.policy=unlimited',
  ]);
  t.end();
});
