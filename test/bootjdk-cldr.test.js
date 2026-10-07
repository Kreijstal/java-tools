'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(__dirname, '..', 'tools', 'bootjdk', 'tools');
const { JHashMap, JHashSet } = require(path.join(dir, 'cldr-jhashmap'));
const { JTreeMap } = require(path.join(dir, 'cldr-treemap'));
const L = require(path.join(dir, 'cldr-locale'));
const { parseFile } = require(path.join(dir, 'cldr-sax'));
const cldr = require(path.join(dir, 'cldrconverter'));

test('HashMap iterates by bucket, then insertion order, and resizes like Java', (t) => {
  const m = new JHashMap();
  for (const k of ['b', 'q', 'a']) m.put(k, 1); // a=97 -> 1, b=98 -> 2, q=113 -> 1
  t.deepEqual([...m.keys()], ['q', 'a', 'b']);
  m.remove('q');
  m.put('q', 2);
  t.deepEqual([...m.keys()], ['a', 'q', 'b']);
  // 13th entry grows the table to 32: 'q' (113 & 31 = 17) moves behind 'b'
  for (let i = 0; i < 10; i++) m.put('k' + i, i);
  t.equal(m.table.length, 32);
  t.ok([...m.keys()].indexOf('q') > [...m.keys()].indexOf('b'));
  // computeIfAbsent inserts at the bin head
  const c = new JHashMap();
  c.computeIfAbsent('a', () => 1);
  c.computeIfAbsent('q', () => 2);
  t.deepEqual([...c.keys()], ['q', 'a']);
  t.deepEqual([...JHashSet.of(['q', 'a'])], ['q', 'a']);
  t.end();
});

test('TreeMap with the non-transitive KeyComparator follows the tree shape', (t) => {
  const m = new JTreeMap(cldr.keyComparator);
  for (const k of ['AC', '001', '%%POSIX']) m.put(k, 1);
  // %%POSIX < 001 < AC < %%POSIX: the order depends on where nodes landed
  t.deepEqual([...m.keys()], ['001', 'AC', '%%POSIX']);
  const m2 = new JTreeMap(cldr.keyComparator);
  for (const k of ['%%POSIX', 'AC', '001']) m2.put(k, 1);
  t.deepEqual([...m2.keys()], ['AC', '%%POSIX', '001']);
  m2.remove('AC');
  t.deepEqual([...m2.keys()], ['%%POSIX', '001']);
  t.end();
});

test('Locale tags and candidate lists', (t) => {
  const tag = (s) => L.toLanguageTag(L.forLanguageTag(s));
  t.equal(tag('ca-ES-VALENCIA'), 'ca-ES-VALENCIA');
  t.equal(tag('iw'), 'he');
  t.equal(tag('und'), 'und');
  t.equal(L.forLanguageTag('und'), L.ROOT);
  const cands = (s) => L.getCandidateLocales(L.forLanguageTag(s)).map(L.toLanguageTag);
  t.deepEqual(cands('zh-TW'), ['zh-Hant-TW', 'zh-Hant', 'zh-TW', 'zh', 'und']);
  t.deepEqual(cands('nb-NO'), ['nb-NO', 'no-NO', 'nb', 'no', 'und']);
  t.deepEqual(cands('en-US-POSIX'), ['en-US-POSIX', 'en-US', 'en', 'und']);
  t.end();
});

test('escape() matches CLDRConverter.escape', (t) => {
  t.equal(cldr.escape(' a "b"\\\t\u0001'), '\\ a \\"b\\"\\\\\\t\\u0001');
  t.equal(cldr.escape(null), '');
  t.end();
});

test('SAX: DTD defaults, ignorable whitespace and Xerces text chunks', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bootjdk-cldr-'));
  fs.writeFileSync(path.join(d, 'x.dtd'), [
    '<!ELEMENT r ( e* ) >',
    '<!ELEMENT e ( #PCDATA ) >',
    '<!ATTLIST e type NMTOKEN "standard" >',
    '<!ATTLIST e list NMTOKENS #IMPLIED >',
  ].join('\n'));
  fs.writeFileSync(path.join(d, 'x.xml'), '<?xml version="1.0"?>\n<!DOCTYPE r SYSTEM "x.dtd">\n'
    + '<r>\n  <e list="  a   b ">x&amp;y</e>\n  <e type="t">0𞤁𞤶z</e>\n</r>\n');
  const events = [];
  parseFile(path.join(d, 'x.xml'), {
    startElement: (q, a) => events.push(`<${q} ${a.getValue('type')} ${a.getValue('list')}>`),
    endElement: (q) => events.push(`</${q}>`),
    characters: (s) => events.push(JSON.stringify(s)),
  });
  t.deepEqual(events, [
    '<r null null>',
    '<e standard a b>', '"x"', '"&"', '"y"', '</e>',
    '<e t null>', JSON.stringify('0𞤁'), JSON.stringify('𞤶'), '"z"', '</e>',
    '</r>',
  ]);
  fs.rmSync(d, { recursive: true });
  t.end();
});
