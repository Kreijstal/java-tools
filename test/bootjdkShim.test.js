'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SHIM = path.join(__dirname, '..', 'tools', 'bootjdk');
const spp = require(path.join(SHIM, 'tools', 'spp'));
const jfrgen = require(path.join(SHIM, 'tools', 'jfrgen'));
const { patchStylesheet } = require(path.join(SHIM, 'tools', 'jvmtigen'));
const { parseArgs } = require(path.join(SHIM, 'javac'));
const { LNSEP } = require(path.join(SHIM, 'tools', 'util'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootjdk-shim-'));
}

test('Spp port expands keys, variables and conditionals like the Java tool', (t) => {
  const dir = tmpdir();
  const template = [
    '#warn',
    'class $Type$ {',
    '#if[rw]',
    '  rw line',
    '#else[rw]',
    '  ro line',
    '#end[rw]',
    '  {#if[rw]?Writable:ReadOnly} {#if[!rw]?no} $x$',
    '  // ## dropped',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'in'), template);
  const run = (args) => {
    const out = path.join(dir, 'out');
    fs.rmSync(out, { force: true });
    t.equal(spp.main([...args, `-i${path.join(dir, 'in')}`, `-o${out}`]), 0, `spp ${args.join(' ')} succeeds`);
    return fs.readFileSync(out, 'utf8');
  };
  const N = LNSEP;
  t.equal(run(['-Krw', '-DType=Foo', '-Dx=1']),
    `// -- This file was mechanically generated: Do not edit! -- //${N}class Foo {${N}${N}  rw line${N}${N}${N}${N}  Writable  1${N}${N}}${N}`,
    'read-write expansion keeps blank lines for removed template lines');
  t.equal(run(['-nel', '-DType=Foo', '-Dx=$1']),
    `// -- This file was mechanically generated: Do not edit! -- //${N}class Foo {${N}  ro line${N}  ReadOnly no ${N}${N}}${N}`,
    '-nel drops removed lines; $ in a value is a group reference, as with Matcher.appendReplacement');
  fs.rmSync(dir, { recursive: true, force: true });
  t.end();
});

test('JFR generator port writes the event and type headers', (t) => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'metadata.xml'), `<?xml version="1.0"?>
<!-- comment -->
<Metadata>
  <Event name="Tick" category="Test" label="Tick" period="everyChunk" startTime="false">
    <Field type="long" name="count" label="Count &amp; more" />
  </Event>
  <Event name="Work" category="Test" label="Work" thread="true">
    <Field type="Thread" name="worker" label="Worker" />
  </Event>
  <Type name="Thread" label="Thread">
    <Field type="string" name="name" label="Name" />
  </Type>
  <XmlType name="long" parameterType="s8" fieldType="s8" javaType="long" />
  <XmlType name="string" parameterType="const char*" fieldType="const char*" javaType="java.lang.String" />
</Metadata>
`);
  const code = jfrgen.main(['--mode', 'headers', '--xml', path.join(dir, 'metadata.xml'),
    '--xsd', 'unused.xsd', '--output', dir]);
  t.equal(code, 0, 'generator succeeds');
  const ids = fs.readFileSync(path.join(dir, 'jfrEventIds.hpp'), 'utf8');
  t.ok(ids.includes('  JfrTickEvent = 2,\n  JfrWorkEvent = 3,\n'), 'events are numbered after the reserved ids');
  t.ok(ids.includes('static const int NUMBER_OF_EVENTS = 2;'), 'event count');
  const types = fs.readFileSync(path.join(dir, 'jfrTypes.hpp'), 'utf8');
  t.ok(types.includes('  TYPE_THREAD = 4,\n  TYPE_LONG = 5,\n  TYPE_STRING = 6,\n'), 'types follow the events, primitives last');
  const periodic = fs.readFileSync(path.join(dir, 'jfrPeriodic.hpp'), 'utf8');
  t.ok(periodic.includes('      case JfrTickEvent:\n        requestTick();\n'), 'periodic events are dispatched');
  const classes = fs.readFileSync(path.join(dir, 'jfrEventClasses.hpp'), 'utf8');
  t.ok(classes.includes('  static const bool isInstant = true;'), 'startTime="false" makes an instant event');
  t.ok(classes.includes('  void set_worker(u8 new_value) {'), 'constant pool references are u8');

  const blob = path.join(dir, 'metadata.bin');
  t.equal(jfrgen.main(['--mode', 'metadata', '--xml', path.join(dir, 'metadata.xml'), '--xsd', 'x', '--output', blob]), 0);
  const b = fs.readFileSync(blob);
  t.equal(b.readInt32BE(0), 5, 'metadata blob starts with the type count');
  t.equal(b.readInt32BE(4), 1, 'first type has one field');
  t.equal(b.toString('latin1', 8 + 2, 8 + 2 + 5), 'count', 'field names are written with writeUTF');
  fs.rmSync(dir, { recursive: true, force: true });
  t.end();
});

test('jvmtiGen stand-in adapts the stylesheets for libxslt', (t) => {
  t.equal(patchStylesheet('<xsl:choose>g\n  <xsl:when test="x"/>'), '<xsl:choose>\n  <xsl:when test="x"/>');
  t.equal(patchStylesheet('<xsl:sort select="@id"/>'), '<xsl:sort select="@id" lang="en"/>');
  t.equal(patchStylesheet('<xsl:sort select="@num" data-type="number"/>'), '<xsl:sort select="@num" data-type="number"/>',
    'numeric sorts need no collation');
  t.end();
});

test('shim java launcher reports a version and dispatches main classes', (t) => {
  const launcher = path.join(SHIM, 'launcher.js');
  const v = spawnSync(process.execPath, [launcher, 'java', '-Xlog:all=off:stdout', '-version'], { encoding: 'utf8' });
  t.equal(v.status, 0);
  t.ok(/ version "28"/.test(v.stderr) && v.stderr.includes('64-Bit'), 'configure can parse the version banner');

  const missing = spawnSync(process.execPath, [launcher, 'java', '-cp', 'x', '-Dfoo=bar', 'build.tools.Missing'], { encoding: 'utf8' });
  t.equal(missing.status, 1);
  t.ok(missing.stderr.includes('no JavaScript implementation of build.tools.Missing'));

  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'in'), '$a$\n');
  const r = spawnSync(process.execPath, [launcher, 'java', '-Xms32M', '-cp', 'classes', 'build.tools.spp.Spp',
    '-Da=b', `-i${path.join(dir, 'in')}`, `-o${path.join(dir, 'out')}`], { encoding: 'utf8' });
  t.equal(r.status, 0, r.stderr);
  t.equal(fs.readFileSync(path.join(dir, 'out'), 'utf8'), `b${LNSEP}`, 'launcher options are skipped before the main class');
  fs.rmSync(dir, { recursive: true, force: true });
  t.end();
});

test('shim javac accepts the build\'s javac options', (t) => {
  const o = parseArgs(['-J-Xmx512M', '-encoding', 'utf-8', '-Werror', '-Xlint:-rawtypes,-cast',
    '-XDmodifiedInputs=list', '--release', '27', '-implicit:none', '-cp', `a${path.delimiter}b`, '-d', 'out', 'A.java']);
  t.deepEqual(o, { out: 'out', roots: ['a', 'b'], files: ['A.java'], encoding: 'utf-8' });
  t.equal(parseArgs(['-d', 'out', '-h', 'hdrs', 'A.java']).headerDir, 'hdrs', '-h names the JNI header directory');
  t.throws(() => parseArgs(['-d', 'out', '--frobnicate', 'A.java']), /unknown option/);
  t.end();
});
