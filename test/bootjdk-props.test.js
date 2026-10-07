'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = path.join(__dirname, '..', 'tools', 'bootjdk', 'tools');
const { loadProperties } = require(path.join(T, 'props-load'));
const cp = require(path.join(T, 'compileproperties'));
const pp = require(path.join(T, 'propertiesparser'));
const fg = require(path.join(T, 'flagsgenerator'));
const nimbus = require(path.join(T, 'generatenimbus'));
const jl = require(path.join(T, 'props-javalang'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootjdk-props-'));
}

function quietly(fn) {
  const w = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = w; }
}

test('Properties.load: separators, escapes, continuations, comments', (t) => {
  const p = loadProperties([
    '# comment',
    '  ! also comment',
    'a=1',
    'b : 2',
    'c 3',
    'd\\ e=4\\',
    '    5',
    'f=\\u00e9\\t\\x',
    'g',
    'h=x\\\\',
    'a=last',
    'i=one\\',
    '   # not a comment',
  ].join('\r\n'));
  t.deepEqual([...p.entries()], [
    ['a', 'last'], ['b', '2'], ['c', '3'], ['d e', '45'], ['f', 'é\tx'], ['g', ''], ['h', 'x\\'], ['i', 'one# not a comment'],
  ]);
  t.end();
});

test('CompileProperties writes a sorted, escaped ListResourceBundle', (t) => {
  const d = tmpdir();
  const src = path.join(d, 'src', 'share', 'classes', 'foo', 'bar');
  const out = path.join(d, 'gensrc', 'mod', 'foo', 'bar');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(src, 'R.properties'), 'z=last "q"\nb=ü\\n\n');
  t.equal(quietly(() => cp.main(['-quiet', '-compile', path.join(src, 'R.properties'), path.join(out, 'R.java'), 'ListResourceBundle'])), 0);
  t.equal(fs.readFileSync(path.join(out, 'R.java'), 'latin1'),
    'package foo.bar;\n\nimport java.util.ListResourceBundle;\n\n'
    + 'public final class R extends ListResourceBundle {\n'
    + '    protected final Object[][] getContents() {\n'
    + '        return new Object[][] {\n'
    + '            { "b", "\\u00FC\\n" },\n'
    + '            { "z", "last \\"q\\"" },\n'
    + '        };\n    }\n}\n');
  const argf = path.join(d, 'args');
  fs.writeFileSync(argf, `-compile ${path.join(src, 'R.properties')} ${path.join(out, 'R2.java')} java.util.ListResourceBundle\n`);
  t.equal(quietly(() => cp.langtools.main(['-quiet', '@' + argf])), 0);
  const lt = fs.readFileSync(path.join(out, 'R2.java'), 'latin1');
  t.ok(lt.startsWith('package foo.bar;\n\npublic final class R2 extends java.util.ListResourceBundle {\n'));
  t.end();
});

test('Java number formatting and HashMap order', (t) => {
  const f = (x) => jl.floatToString(Math.fround(x));
  t.deepEqual([0.1, 1, 1e-5, 1e7, 1.28515625, 1.4e-45, 0.001].map(f),
    ['0.1', '1.0', '1.0E-5', '1.0E7', '1.2851562', '1.4E-45', '0.001']);
  t.equal(jl.doubleToString(Math.fround(0.1)), '0.10000000149011612');
  t.equal(jl.doubleToString(-1.5625), '-1.5625');
  const m = new jl.JHashMap();
  for (const k of ['PACKAGE', 'LAF_NAME', 'BODY', 'STATE_KEY', 'STATE_NAME']) m.put(k, k);
  // a copy of a small map gets a smaller table (5 entries -> capacity 8)
  const copy = new jl.JHashMap(m);
  t.equal(m.cap, 16);
  t.equal(copy.cap, 8);
  t.deepEqual(copy.entries().map((e) => e[0]), ['STATE_NAME', 'LAF_NAME', 'BODY', 'PACKAGE', 'STATE_KEY']);
  t.deepEqual(m.entries().map((e) => e[0]), ['STATE_NAME', 'PACKAGE', 'STATE_KEY', 'LAF_NAME', 'BODY']);
  t.equal(jl.stringHash('polygenelubricants'), -2147483648);
  t.end();
});

test('PropertiesParser generates factory classes', (t) => {
  const d = tmpdir();
  const dir = path.join(d, 'com', 'x', 'resources');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo.properties'), [
    '# 0: symbol, 1: list of type or string',
    'demo.err.bad.thing=\\',
    '    bad {0} {1}',
    '',
    '# lint: some-lint',
    'demo.warn.w1=careful',
    '',
    'demo.misc.frag=frag',
    '',
  ].join('\n'));
  t.equal(quietly(() => pp.main(['-compile', path.join(dir, 'demo.properties'), dir])), 0);
  const out = fs.readFileSync(path.join(dir, 'DemoProperties.java'), 'utf8');
  t.ok(out.startsWith('package com.x.resources;\n\nimport com.sun.tools.javac.code.Symbol;\nimport com.sun.tools.javac.code.Type;\nimport java.util.List;\n'));
  t.ok(out.includes('    public static class Errors {\n'));
  t.ok(out.includes('public static Error BadThing(Symbol arg0, List<? extends Type> arg1)'));
  t.ok(out.includes('public static Error BadThing(Symbol arg0, String arg1)'));
  t.ok(out.includes('new LintWarning(EnumSet.noneOf(DiagnosticFlag.class), LintCategory.SOME_LINT, "demo", "w1")'));
  t.ok(out.includes('public static final Fragment Frag = new Fragment(EnumSet.noneOf(DiagnosticFlag.class), "demo", "frag");'));
  t.ok(pp.messageFormat("'{'{0}'}' ''", ['x']) === "{x} '");
  t.end();
});

test('FlagsGenerator evaluates annotated constants', (t) => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'Flags.java'), [
    'package p;',
    'public class Flags {',
    '    @Use({FlagTarget.CLASS}) public static final int A = 1;',
    '    @Use(FlagTarget.METHOD) @NoToStringValue public static final int B = 1<<0;',
    '    @Use({FlagTarget.CLASS})',
    '    @CustomToStringValue("non-sealed")',
    '    public static final long C_D = 1L<<63; // top',
    '    @NotFlag public static final int X = A | B, Y = (int)C_D;',
    '    public static String s(long f) { return "{"; }',
    '    public enum FlagTarget { CLASS, METHOD }',
    '}',
  ].join('\n'));
  t.equal(fg.main([path.join(d, 'Flags.java'), path.join(d, 'FlagsEnum.java')]), 0);
  const out = fs.readFileSync(path.join(d, 'FlagsEnum.java'), 'utf8');
  t.ok(out.includes('    A_OR_B(1L<<0, "a"),'));
  t.ok(out.includes('    C_D(1L<<63, "non-sealed"),'));
  t.end();
});

test('generatenimbus writes painters and defaults', (t) => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'PainterImpl.template'), 'package ${PACKAGE};\nclass ${PAINTER_NAME} {\n${STATIC_DECL}${SHAPES_DECL}}\n');
  fs.writeFileSync(path.join(d, 'StateImpl.template'), 'class ${STATE_NAME} {${BODY}}\n');
  fs.writeFileSync(path.join(d, 'Defaults.template'), 'class ${LAF_NAME}Defaults {\n${STYLE_INIT}${UI_DEFAULT_INIT}}\n');
  const matte = '<matte red="1" green="2" blue="3" alpha="255" hueOffset="0" saturationOffset="0" brightnessOffset="0" alphaOffset="0"/>';
  fs.writeFileSync(path.join(d, 'skin.laf'), `<?xml version="1.0"?>
<synthModel>
  <colors><uiColor name="c1">${matte}</uiColor></colors>
  <fonts/>
  <style/>
  <components>
    <uiComponent name="Button" componentName="Foo.bar">
      <stateTypes><stateType key="Odd"><codeSnippet><![CDATA[ x < y ]]></codeSnippet></stateType></stateTypes>
      <contentMargins top="1" left="2" bottom="3" right="4"/>
      <style/>
      <backgroundStates>
        <state stateKeys="Enabled">
          <style/>
          <canvas>
            <size width="10" height="10"/>
            <layer><shapes>
              <rectangle x1="1" x2="9" y1="1" y2="9" rounding="0">${matte}</rectangle>
            </shapes></layer>
            <stretchingInsets top="2" left="2" bottom="2" right="2"/>
          </canvas>
        </state>
      </backgroundStates>
    </uiComponent>
  </components>
</synthModel>
`);
  const out = path.join(d, 'out');
  t.equal(quietly(() => nimbus.main(['-skinFile', path.join(d, 'skin.laf'), '-buildDir', out, '-packagePrefix', 'a.b', '-lafName', 'N'])), 0);
  const dir = path.join(out, 'a', 'b');
  t.deepEqual(fs.readdirSync(dir).sort(), ['FooBarOddState.java', 'FooBarPainter.java', 'NDefaults.java']);
  const painter = fs.readFileSync(path.join(dir, 'FooBarPainter.java'), 'utf8');
  t.ok(painter.includes('static final int BACKGROUND_ENABLED = 1;'));
  t.ok(painter.includes('rect.setRect(decodeX(0.5f), //x'));
  const defs = fs.readFileSync(path.join(dir, 'NDefaults.java'), 'utf8');
  t.ok(defs.includes('register(Region.BUTTON, "\\"Foo.bar\\"");'));
  t.ok(defs.includes('d.put("\\"Foo.bar\\".States", "Odd");'));
  t.ok(defs.includes('addColor(d, "c1", 1, 2, 3, 255);'));
  t.ok(fs.readFileSync(path.join(dir, 'FooBarOddState.java'), 'utf8').includes(' x < y '));
  t.end();
});
