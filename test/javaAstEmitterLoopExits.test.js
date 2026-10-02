'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {treeToStatements, emitStatements, promoteBooleanStackCarriers, factorCommonBranchTails,
  removeDeadRegionSelectors, removeDeadReceiverSnapshots} = require('../src/decompiler/javaAstEmitter');
const {printTree} = require('../src/decompiler/structurer');
const {JavaParser} = require('../src/java-frontend/parser');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');

const seq = (...body) => ({t: 'seq', body});
const straight = block => ({t: 'straight', block});
const jump = (t, label) => ({t, label});
function candidate(exitTree, trailing = false) {
  return {t: 'loop', label: 'Outer', body: seq(straight(0), {
    t: 'if', block: 0, then: trailing ? seq() : exitTree,
    els: seq(straight(2), jump('continue', 'Outer')),
  }, ...(trailing ? [exitTree] : []))};
}
const render = {
  straight: block => ({0: [], 1: ["trace.append('i'); count++;"],
    2: ["trace.append('o'); if (++count > limit + 10) return count+\":\"+trace;"],
    3: ["trace.append('t'); if ((count & 1) == 0) throw new IllegalArgumentException();"],
    4: ['return count+":"+trace;'], 5: ["trace.append('c');"]}[block]),
  cond: () => 'count < limit',
  condInverted: () => 'count >= limit',
  blockTerminates: block => block === 4,
};
const emitted = tree => emitStatements(treeToStatements(tree, render));

for (const kind of ['loop', 'block']) {
  test(`a break consumed by an inner ${kind} cannot justify rotating an outer exit`, () => {
    const exit = {t: kind, label: 'Inner', body: seq(straight(1), jump('break', 'Inner'))};
    assert.match(emitted(candidate(exit)), /Outer: while \(true\)/);
  });
}

test('a conditional break from an inner loop still allows normal completion', () => {
  const exit = {t: 'loop', label: 'Inner', body: seq(straight(1), {
    t: 'if', block: 0, then: jump('break', 'Inner'), els: jump('continue', 'Inner'),
  })};
  assert.match(emitted(candidate(exit)), /Outer: while \(true\)/);
});

test('normally completing trailing statements remain inside the outer loop', () => {
  const exit = {t: 'loop', label: 'Inner', body: seq(straight(1), jump('break', 'Inner'))};
  assert.match(emitted(candidate(exit, true)), /Outer: while \(true\)/);
});

test('breaks in catch and synchronized bodies stay bound to their inner loop', () => {
  for (const guarded of [
    {t: 'try', body: straight(3), catches: [{types: ['IllegalArgumentException'],
      varName: 'error', body: jump('break', 'Inner')}]},
    {t: 'synchronized', lockLocal: 0, body: jump('break', 'Inner')},
  ]) {
    const exit = {t: 'loop', label: 'Inner', body: seq(straight(1), guarded)};
    assert.match(emitted(candidate(exit)), /Outer: while \(true\)/);
  }
});

test('real returns and loops without an internal break still permit rotation', () => {
  for (const exit of [straight(4),
    {t: 'loop', label: 'Inner', body: seq(straight(4), jump('continue', 'Inner'))},
    {t: 'block', label: 'Inner', body: jump('break', 'Enclosing')},
  ]) assert.match(emitted({t: 'block', label: 'Enclosing', body: candidate(exit)}),
    /Outer: while \(count >= limit\)/);
});

test('intact protected exit arms require abrupt bodies and every abrupt handler', () => {
  const protectedExit = {t: 'try', body: straight(4), catches: [
    {types: ['IllegalArgumentException'], varName: 'error', body: straight(4)},
  ]};
  for (const trailing of [false, true]) {
    assert.match(emitted(candidate(protectedExit, trailing)), /Outer: while \(count >= limit\)/);
  }
  for (const exit of [
    {...protectedExit, body: straight(1)},
    {...protectedExit, catches: [...protectedExit.catches,
      {types: ['Exception'], varName: 'other', body: straight(1)}]},
    {...protectedExit, catches: [{types: ['IllegalArgumentException'], varName: 'error',
      body: {t: 'block', label: 'Consumed', body: jump('break', 'Consumed')}}]},
    {...protectedExit, catches: [{types: ['IllegalArgumentException'], varName: 'error',
      body: jump('continue', 'Outer')}]},
  ]) {
    for (const trailing of [false, true]) {
      assert.match(emitted(candidate(exit, trailing)), /Outer: while \(true\)/);
    }
  }
});

test('whole synchronized exit arms preserve monitor scope and refuse consumed breaks', () => {
  const exit = {t: 'synchronized', lockLocal: 0, body: straight(4)};
  const source = emitted(candidate(exit));
  assert.match(source, /Outer: while \(count >= limit\)/);
  assert.match(source, /\}\s+synchronized \(lock0\) \{\s+return/);
  for (const body of [straight(1),
    {t: 'loop', label: 'Consumed', body: seq(straight(1), jump('break', 'Consumed'))},
  ]) assert.match(emitted(candidate({...exit, body})), /Outer: while \(true\)/);
  // An exit that continues this loop cannot be moved out of its label scope.
  assert.match(emitted(candidate({...exit, body: jump('continue', 'Outer')})), /Outer: while \(true\)/);
});

test('protected loop-exit rotation matches native catch priority and monitor release', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-protected-loop-rotation-'));
  try {
    const body = "trace.append('t'); if(mode==1) throw failure; if(mode==2) throw fatal; return finish(count,trace,lock0);";
    const caught = "trace.append('c'); return finish(count,trace,lock0);";
    const general = "trace.append('g'); return count+\":\"+trace;";
    const variants = [
      {tree: {t: 'try', body: straight(10), catches: [
        {types: ['IllegalArgumentException'], varName: 'error', body: straight(11)},
      ]}, source: `try { ${body} } catch(IllegalArgumentException error) { ${caught} }`},
      {tree: {t: 'synchronized', lockLocal: 0, body: straight(10)},
        source: `synchronized(lock0) { ${body} }`},
      {tree: {t: 'synchronized', lockLocal: 0, body: {t: 'try', body: straight(10), catches: [
        {types: ['IllegalArgumentException'], varName: 'error', body: straight(11)},
      ]}}, source: `synchronized(lock0) { try { ${body} } catch(IllegalArgumentException error) { ${caught} } }`},
      {tree: {t: 'try', body: {t: 'synchronized', lockLocal: 0, body: straight(10)}, catches: [
        {types: ['IllegalArgumentException'], varName: 'error', body: straight(11)},
      ]}, source: `try { synchronized(lock0) { ${body} } } catch(IllegalArgumentException error) { ${caught} }`},
      {tree: {t: 'try', body: straight(10), catches: [
        {types: ['IllegalArgumentException'], varName: 'specific', body: straight(11)},
        {types: ['RuntimeException'], varName: 'general', body: straight(12)},
      ]}, source: `try { ${body} } catch(IllegalArgumentException specific) { ${caught} }
        catch(RuntimeException other) { ${general} }`},
    ];
    const renderer = {...render,
      straight: id => id===10?[body]:id===11?[caught]:id===12?[general]:render.straight(id),
      blockTerminates: id => [10,11,12].includes(id)||render.blockTerminates(id)};
    let cases = 0;
    for (const [variantIndex, variant] of variants.entries()) for (const trailing of [false, true]) {
      const index = variantIndex * 2 + Number(trailing);
      const rebuilt=emitStatements(treeToStatements(candidate(variant.tree, trailing),renderer));
      assert.match(rebuilt,/Outer: while \(count >= limit\)/);
      const original=`outer: while(true) { if(count < limit) { ${trailing ? '' : variant.source} }
        else { trace.append('o'); if(++count > limit+10) return count+":"+trace; continue outer; }
        ${trailing ? variant.source : ''} }`;
      const source=`public class ProtectedRotation${index} {
        static final IllegalArgumentException failure=new IllegalArgumentException();
        static final Error fatal=new Error();static Object lastLock;static String lastTrace;
        static String finish(int count,StringBuilder trace,Object lock) {
          return count+":"+trace+":"+Thread.holdsLock(lock);
        }
        ${Object.entries({original,rebuilt}).map(([name,body])=>`static String ${name}(int limit,int mode) {
          int count=0;StringBuilder trace=new StringBuilder();Object lock0=mode==3?null:new Object();
          lastLock=lock0;try { ${body} } finally { lastTrace=trace.toString(); }
        }`).join('\n')}
        static String invoke(boolean rebuilt,int limit,int mode) {
          String result;try { result=rebuilt?rebuilt(limit,mode):original(limit,mode); }
          catch(Throwable error) {result=error==failure?"same-failure":error==fatal?"same-fatal":error.getClass().getName();}
          if(lastLock!=null&&Thread.holdsLock(lastLock))throw new AssertionError("leaked monitor");
          return result+":"+lastTrace;
        }
        public static void main(String[]args) { for(int limit=-15;limit<=40;limit++)for(int mode=0;mode<4;mode++) {
          String expected=invoke(false,limit,mode),actual=invoke(true,limit,mode);
          if(!expected.equals(actual))throw new AssertionError(limit+":"+mode+":"+expected+":"+actual);
          System.out.println(limit+":"+mode+":"+actual);
        } }
      }`;
      const file=path.join(temporary,`ProtectedRotation${index}.java`);fs.writeFileSync(file,source);
      run('javac',['--release','8','-d',temporary,file],temporary);
      const output=run('java',['-cp',temporary,`ProtectedRotation${index}`],temporary);
      assert.equal(output.trim().split('\n').length,224);cases+=224;
    }
    assert.equal(cases,2240);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('dead selector cleanup requires allocator identities and accounts for every occurrence', () => {
  const name = 'decompiledRegionSelector0', declaration = `int ${name} = 0;`;
  const source = `trace.append("${name}"); // ${name} in documentation
try { work(); ${name} = 0; } catch (Exception error) { ${name} = 1; }
if (${name} == 0) {} else {}
finish();`;
  const result = removeDeadRegionSelectors(source, [declaration, 'int count = 0;'], [name]);
  assert.deepEqual(result.removed, [name]);
  assert.deepEqual(result.declarations, ['int count = 0;']);
  assert.equal(result.source, `trace.append("${name}"); // ${name} in documentation
try { work();  } catch (Exception error) {  }
finish();`);
  assert.equal(removeDeadRegionSelectors(source, [declaration], []).source, source);
  assert.equal(removeDeadRegionSelectors(source, [`Integer ${name} = 0;`], [name]).source, source);
  assert.equal(removeDeadRegionSelectors(source, [declaration, declaration], [name]).source, source);
  const live = 'decompiledRegionSelector1';
  const mixed = `${source}\n${live} = 1; return ${live};`;
  const selected = removeDeadRegionSelectors(mixed, [declaration, `int ${live} = 0;`], [name, live]);
  assert.deepEqual(selected.removed, [name]);
  assert.match(selected.source, /decompiledRegionSelector1 = 1; return decompiledRegionSelector1;/);
});

test('selector reads, effects, shadowing, unsupported syntax and scalar bodies refuse cleanup', () => {
  const name = 'decompiledRegionSelector0', declaration = `int ${name} = 0;`;
  for (const source of [
    `${name} = 0; return ${name};`,
    `${name} = 0; if (${name} == 0) { work(); }`,
    `${name} = work(); if (${name} == 0) {}`,
    `${name} = nullable; if (${name} == 0) {}`,
    `${name}++; if (${name} == 0) {}`,
    `${name} += 1; if (${name} == 0) {}`,
    `${name} = 1; if (other.${name} == 0) {}`,
    `${name} = 1; if (${name} == effect()) {}`,
    `${name} = 1; if (${name} / 0 == 0) {}`,
    `${name} = 1; if (${name} == 0) {} else { work(); }`,
    `if (pick()) ${name} = 0; if (${name} == 0) {}`,
    `${name} = 1; if (pick()) if (${name} == 0) {} else { work(); }`,
    `${name} = 1; label: if (${name} == 0) {}`,
    `{ int ${name} = 0; if (${name} == 0) {} }`,
    `${name} = 1; unknown @ syntax;`,
    `${name} = 1; } return 7; {`,
    `${name} = 1; /* \\u0061 */ if (${name} == 0) {}`,
    `${name} = 2147483648; if (${name} == 0) {}`,
  ]) {
    const result = removeDeadRegionSelectors(source, [declaration], [name]);
    assert.equal(result.source, source, source);
    assert.deepEqual(result.removed, [], source);
  }
  const source = `${name} = 1; if (${name} == 0) {}`;
  assert.equal(removeDeadRegionSelectors(source, [declaration, `int other = ${name};`], [name]).source, source);
});

test('dead routing cleanup preserves native effects, failures, catch priority and lock ownership', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-dead-region-routing-'));
  try {
    const name = 'decompiledRegionSelector0', declaration = `int ${name} = 0;`;
    const guarded = `try { work(mode,trace); ${name} = 0; }
      catch (IllegalArgumentException specific) { trace.append('s'); ${name} = 1; }
      catch (RuntimeException general) { trace.append('g'); ${name} = 2; }
      if (${name} == 0) {}`;
    const variants = [guarded,
      `synchronized(lock) { trace.append(Thread.holdsLock(lock)); ${guarded} }`,
      `try { synchronized(lock) { ${guarded} } } finally { trace.append('f'); }`,
      `for(int index=0;index<3;index++) { ${guarded} }
       if (nullable) {} else {} trace.append('n');`,
    ];
    let cases = 0;
    for (const [index, body] of variants.entries()) {
      const result = removeDeadRegionSelectors(body, [declaration], [name]);
      assert.deepEqual(result.removed, [name]);
      const methods = {original: declaration + '\n' + body,
        rebuilt: result.declarations.join('\n') + '\n' + result.source};
      const source = `public class DeadRouting${index} {
        static final IllegalArgumentException specific=new IllegalArgumentException();
        static final RuntimeException general=new RuntimeException();
        static final Error fatal=new Error(); static Object lock; static StringBuilder trace;
        static void work(int mode,StringBuilder trace) {
          trace.append('w'); if(mode==1)throw specific; if(mode==2)throw general; if(mode==3)throw fatal;
        }
        ${Object.entries(methods).map(([method, code]) => `static void ${method}(int mode,Boolean nullable) {
          ${code} trace.append('e'); }`).join('\n')}
        static String invoke(boolean rebuilt,int mode,boolean nullLock,Boolean nullable) {
          trace=new StringBuilder(); lock=nullLock?null:new Object();String result="ok";
          try { if(rebuilt)rebuilt(mode,nullable);else original(mode,nullable); }
          catch(Throwable error) {result=error==specific?"same-specific":error==general?"same-general":
            error==fatal?"same-fatal":error.getClass().getName();}
          if(lock!=null && Thread.holdsLock(lock))throw new AssertionError("monitor retained");
          return result+":"+trace;
        }
        public static void main(String[]args) {
          for(int mode=0;mode<4;mode++)for(boolean nullLock:new boolean[]{false,true})
          for(Boolean nullable:new Boolean[]{null,false,true}) {
            String expected=invoke(false,mode,nullLock,nullable),actual=invoke(true,mode,nullLock,nullable);
            if(!expected.equals(actual))throw new AssertionError(expected+":"+actual);
            System.out.println(mode+":"+nullLock+":"+nullable+":"+actual);
          }
        }
      }`;
      const file = path.join(temporary, `DeadRouting${index}.java`); fs.writeFileSync(file, source);
      run('javac', ['--release', '8', '-d', temporary, file], temporary);
      assert.equal(run('java', ['-cp', temporary, `DeadRouting${index}`], temporary).trim().split('\n').length, 24);
      cases += 24;
    }
    assert.equal(cases, 96);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const fds = files.map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...fds], timeout: 15000,
      env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'}});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally { fds.forEach(fd => fs.closeSync(fd)); }
}

test('emitted nested-loop and protected exits match native Java effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-loop-exits-'));
  try {
    const variants = [
      {tree: seq(straight(1), jump('break', 'Inner')),
        source: "trace.append('i'); count++; break inner;"},
      {tree: seq(straight(1), {t: 'try', body: straight(3), catches: [
        {types: ['IllegalArgumentException'], varName: 'error',
          body: seq(straight(5), jump('break', 'Inner'))},
      ]}, jump('break', 'Inner')),
        source: `trace.append('i'); count++; try {
          trace.append('t'); if ((count & 1) == 0) throw new IllegalArgumentException(); }
          catch (IllegalArgumentException error) { trace.append('c'); break inner; } break inner;`},
      {tree: {t: 'synchronized', lockLocal: 0,
        body: seq(straight(1), jump('break', 'Inner'))},
        source: "synchronized (lock0) { trace.append('i'); count++; break inner; }"},
      {tree: seq(straight(1), jump('break', 'Inner')), trailing: true,
        source: "trace.append('i'); count++; break inner;"},
    ];
    for (const [index, variant] of variants.entries()) {
      const native = `outer: while (true) { if (count < limit) {
        inner: while (true) { ${variant.source} }
      } else { trace.append('o'); if (++count > limit + 10) return count+":"+trace;
        continue outer; } }`;
      const rebuilt = printTree(candidate({t: 'loop', label: 'Inner', body: variant.tree},
        variant.trailing), render);
      const methods = {original: native, rebuilt};
      const source = `public class LoopExit${index} {
        ${Object.entries(methods).map(([name, body]) => `static String ${name}(int limit) {
          int count = 0; StringBuilder trace = new StringBuilder();
          Object lock0 = new Object(); ${body} }`).join('\n')}
        public static void main(String[] args) {
          for (int limit = -5; limit <= 100; limit++) {
            String expected = original(limit), actual = rebuilt(limit);
            if (!expected.equals(actual)) throw new AssertionError(limit+":"+expected+":"+actual);
            System.out.println(limit+":"+actual);
          }
        }
      }`;
      const javaFile = path.join(temporary, `LoopExit${index}.java`);
      fs.writeFileSync(javaFile, source);
      run('javac', ['--release', '8', '-d', temporary, javaFile], temporary);
      assert.equal(run('java', ['-cp', temporary, `LoopExit${index}`], temporary)
        .trim().split('\n').length, 106);
    }
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

test('early-exit lowering renders both arms in their original order', () => {
  const calls = [];
  const output = emitStatements(treeToStatements({t: 'if', block: 0,
    then: straight(1), els: straight(2)}, {
    cond: () => { calls.push('condition'); return 'pick()'; },
    straight: id => { calls.push(id); return [id === 1 ? 'work();' : 'return 7;']; },
    condInverted: () => { calls.push('inverse'); return '!pick()'; },
  }));
  assert.deepEqual(calls, ['condition', 1, 2, 'inverse']);
  assert.match(output, /if \(!pick\(\)\) \{\s+return 7;\s+\}\s+work\(\);/);
  assert.doesNotMatch(output, /else/);
});

test('scope and exit proofs parse every statement and reject trailing input', () => {
  const parser = new JavaParser();
  assert.throws(() => parser.parseStatement('{ return 1; } int hidden = 2;',
    {requireComplete: true}), /trailing tokens/);
  // Keep the existing public parser's permissive default for its other users.
  assert.equal(parser.parseStatement('return 1; return 2;').kind, 'ReturnStatement');
  const renderSources = (thenSource, elseSource) => emitStatements(treeToStatements({
    t: 'if', block: 0, then: straight(1), els: straight(2),
  }, {cond: () => 'test', straight: id => [id === 1 ? thenSource : elseSource]}));
  assert.match(renderSources('if (nested)\nreturn 1;', 'work();'), /else/);
  assert.match(renderSources('Inner: { break Inner; }', 'work();'), /else/);
  assert.match(renderSources('return 1;', 'work(); int value = 7; use(value);'),
    /\}\s+\{\s+work\(\); int value = 7;/);
  assert.match(renderSources('return 1;', 'class Value {} use(new Value());'),
    /\}\s+\{\s+class Value/);
  assert.doesNotMatch(renderSources('if (nested) return 1; else return 2;', 'work();'), /\} else \{\s+work/);
  assert.match(renderSources('work();', 'return 2;'), /if \(!\(test\)\)/);
  const shorterGuard = emitStatements(treeToStatements({t: 'if', block: 0,
    then: {t: 'if', block: 1, then: straight(1), els: straight(2)},
    els: straight(3)}, {
    cond: id => id ? 'nested' : 'test',
    straight: id => [`return ${id};`],
  }));
  assert.match(shorterGuard, /^if \(!\(test\)\) \{\s+return 3;\s+\}\s+if \(nested\)/);
});

test('early exits preserve native scopes, effects, NaNs and protected transfers', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-early-exits-'));
  try {
    const values = [-Infinity, -2147483648, -7, -0, 0, 7, 2147483647, Infinity, NaN];
    const variants = [
      {then: "trace.append('a'); return done(1, trace);",
        els: "trace.append('b');", tail: "trace.append('z'); return done(2, trace);"},
      {then: "trace.append('a');", els: "trace.append('b'); return done(2, trace);",
        tail: "trace.append('z'); return done(1, trace);", invert: true},
      {then: "if (x < -3) { trace.append('n'); return done(1, trace); } else { trace.append('p'); return done(2, trace); }",
        els: "trace.append('b'); return done(3, trace);", tail: ''},
      {then: 'return done(1, trace);', els: "trace.append('b'); int value = 7; trace.append(value);",
        tail: 'int value = 3; trace.append(value); return done(value, trace);', scope: true},
      {then: 'return done(1, trace);',
        els: 'class Value { int get() { return 7; } } trace.append(new Value().get());',
        tail: 'class Value { int get() { return 3; } } trace.append(new Value().get()); return done(3, trace);', scope: true},
      {then: "trace.append('a'); if (x < -3)\nreturn done(1, trace);", els: "trace.append('b');",
        tail: "trace.append('z'); return done(2, trace);", keepsElse: true},
      {then: "Inner: { trace.append('a'); break Inner; }", els: "trace.append('b');",
        tail: "trace.append('z'); return done(2, trace);", keepsElse: true},
      {then: "synchronized (lock0) { if (!Thread.holdsLock(lock0)) throw new AssertionError(); trace.append('a'); return done(1, trace); }",
        els: "if (Thread.holdsLock(lock0)) throw new AssertionError(); trace.append('b');",
        tail: 'return done(2, trace);'},
      {then: "try { trace.append('t'); if (x < -3) throw failure; return done(1, trace); } catch (IllegalArgumentException caught) { if (caught != failure) throw new AssertionError(); trace.append('c'); return done(2, trace); }",
        els: "trace.append('b');", tail: 'return done(3, trace);'},
      {then: "trace.append('t'); throw failure;", els: "trace.append('b');",
        tail: 'return done(3, trace);'},
    ];
    const methods = [];
    variants.forEach((variant, index) => {
      const rebuilt = emitStatements(treeToStatements({t: 'if', block: 0,
        then: straight(1), els: straight(2)}, {
        cond: () => 'pick(x, trace)',
        // This is the exact complement, including NaN; >= is not the
        // complement of a floating-point < comparison.
        condInverted: variant.invert ? () => '!pick(x, trace)' : undefined,
        straight: id => [id === 1 ? variant.then : variant.els],
      }));
      if (variant.keepsElse) assert.match(rebuilt, /else/);
      else assert.doesNotMatch(rebuilt, /^\} else \{/m);
      if (variant.scope) assert.match(rebuilt, /\}\s+\{/);
      if (variant.invert) assert.match(rebuilt, /if \(!pick\(x, trace\)\)/);
      const original = `if (pick(x, trace)) { ${variant.then} } else { ${variant.els} }`;
      for (const [name, body] of [['original', original], ['rebuilt', rebuilt]]) {
        methods.push(`static String ${name}${index}(double x, Object lock0, IllegalArgumentException failure) {
          StringBuilder trace = new StringBuilder();
          try { ${body} ${variant.tail} } catch (IllegalArgumentException caught) {
            if (caught != failure) throw new AssertionError();
            return done(99, trace);
          }
        }`);
      }
    });
    const source = `public class EarlyExits {
      static boolean pick(double x, StringBuilder trace) { trace.append('q'); return x <= 0; }
      static String done(int result, StringBuilder trace) { return result+":"+trace; }
      ${methods.join('\n')}
      public static void main(String[] args) {
        Object lock = new Object(); IllegalArgumentException failure = new IllegalArgumentException();
        double[] values = {Double.NEGATIVE_INFINITY, -2147483648d, -7d, -0d, 0d,
          7d, 2147483647d, Double.POSITIVE_INFINITY, Double.NaN};
        for (double value : values) {
          ${variants.map((_, index) => `{
            String expected = original${index}(value, lock, failure);
            String actual = rebuilt${index}(value, lock, failure);
            if (!expected.equals(actual) || Thread.holdsLock(lock))
              throw new AssertionError(${index}+":"+value+":"+expected+":"+actual);
            System.out.println(${index}+":"+value+":"+actual);
          }`).join('\n')}
        }
      }
    }`;
    const javaFile = path.join(temporary, 'EarlyExits.java');
    fs.writeFileSync(javaFile, source);
    run('javac', ['--release', '8', '-d', temporary, javaFile], temporary);
    assert.equal(run('java', ['-cp', temporary, 'EarlyExits'], temporary)
      .trim().split('\n').length, variants.length * values.length);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

test('a retained declaration block does not acquire an unreachable default return', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-scoped-return-'));
  try {
    const native = path.join(temporary, 'native');
    const rebuilt = path.join(temporary, 'rebuilt');
    fs.mkdirSync(native); fs.mkdirSync(rebuilt);
    const source = `public class ScopedReturn {
      public static int run(int count, boolean early) {
        try {
          if (early) return 52;
          else {
            int total = 0;
            for (int index = 0; index < count; index++) total += 7 / (index - 2);
            return total;
          }
        } catch (RuntimeException failure) { return -99; }
      }
    }`;
    const javaFile = path.join(native, 'ScopedReturn.java');
    fs.writeFileSync(javaFile, source);
    run('javac', ['--release', '8', '-d', native, javaFile], temporary);
    const decompiled = decompileClassFile(path.join(native, 'ScopedReturn.class'));
    assertNoFallback(decompiled);
    fs.writeFileSync(path.join(rebuilt, 'ScopedReturn.java'), decompiled);
    const driver = `class ScopeRunner {
      public static void main(String[] args) {
        for (int count = -5; count <= 15; count++) for (boolean early : new boolean[]{false,true})
          System.out.println(count+":"+early+":"+ScopedReturn.run(count,early));
      }
    }`;
    for (const directory of [native, rebuilt]) {
      fs.writeFileSync(path.join(directory, 'ScopeRunner.java'), driver);
      run('javac', ['--release', '8', '-d', directory,
        path.join(directory, 'ScopedReturn.java'), path.join(directory, 'ScopeRunner.java')], temporary);
    }
    const expected = run('java', ['-cp', native, 'ScopeRunner'], temporary);
    assert.equal(expected.trim().split('\n').length, 42);
    assert.equal(run('java', ['-cp', rebuilt, 'ScopeRunner'], temporary), expected);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

test('value-producing branches require identical primitive arms and a proven local type', () => {
  const renderPair = (taken, other, type = 'int') => emitStatements(treeToStatements({
    t: 'if', block: 0, then: straight(1), els: straight(2),
  }, {cond: () => 'pick()', straight: id => [id === 1 ? taken : other],
    localType: name => name === 'value' ? type : null}));
  assert.equal(renderPair('value = 0;', 'value = 1;'), 'value = (pick()) ? 0 : 1;');
  assert.equal(renderPair('value = true;', 'value = false;', 'boolean'),
    'value = (pick()) ? true : false;');
  assert.equal(renderPair('value = -0x8000000000000000L;', 'value = 0b1L;', 'long'),
    'value = (pick()) ? -0x8000000000000000L : 0b1L;');
  // Java allows these separately assigned constants; a conditional expression
  // can introduce narrowing, numeric promotion, rounding, or unboxing.
  for (const [taken, other, type] of [
    ['value = 0;', 'value = 1;', null],
    ['value = 0;', 'value = 1;', 'byte'],
    ['value = 0;', 'value = 65535;', 'char'],
    ['value = 0;', 'value = 1;', 'short'],
    ['value = 16777217;', 'value = 1.0f;', 'double'],
    ['value = 9007199254740993L;', 'value = 1.0;', 'double'],
    ['value = true;', 'value = false;', 'Boolean'],
    ['value = null;', 'value = 1;', 'Integer'],
    ['value = left();', 'value = right();', 'int'],
    ['value += 0;', 'value += 1;', 'int'],
    ['value = 0; work();', 'value = 1;', 'int'],
    ['{ value = 0; }', 'value = 1;', 'int'],
    ['holder.value = 0;', 'holder.value = 1;', 'int'],
    ['array[index()] = 0;', 'array[index()] = 1;', 'int'],
    ['int value = 0;', 'int value = 1;', 'int'],
    ['value = 0;', 'different = 1;', 'int'],
  ]) assert.match(renderPair(taken, other, type), /else/, `${taken} / ${other} / ${type}`);
  const calls = [];
  emitStatements(treeToStatements({t: 'if', block: 0, then: straight(1), els: straight(2)}, {
    cond: () => { calls.push('condition'); return 'pick()'; },
    straight: id => { calls.push(id); return [`value = ${id};`]; },
    localType: name => { calls.push(name); return 'int'; },
    condInverted: () => { throw new Error('value branches need no inverse'); },
  }));
  assert.deepEqual(calls, ['condition', 1, 2, 'value']);
});

test('conditional assignments preserve native bits, unboxing, exceptions and effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-value-branches-'));
  try {
    const variants = [
      ['int', '0', '1', 'Integer.toString(value)'],
      ['int', '-0x80000000', '0x7fffffff', 'Integer.toString(value)'],
      ['long', '-0x8000000000000000L', '0x7fffffffffffffffL', 'Long.toString(value)'],
      ['long', '9_007_199_254_740_993L', '0b1L', 'Long.toString(value)'],
      ['float', '-0.0f', '0.0f', 'Integer.toString(Float.floatToRawIntBits(value))'],
      ['float', '3.4028235e38f', '1.4e-45f', 'Integer.toString(Float.floatToRawIntBits(value))'],
      ['double', '-0.0', '0.0', 'Long.toString(Double.doubleToRawLongBits(value))'],
      ['double', '1.7976931348623157E308', '4.9E-324', 'Long.toString(Double.doubleToRawLongBits(value))'],
      ['boolean', 'true', 'false', 'Boolean.toString(value)'],
      ['boolean', 'false', 'true', 'Boolean.toString(value)'],
    ];
    const methods = [];
    variants.forEach(([type, taken, other, result], index) => {
      const reconstructed = emitStatements(treeToStatements({t: 'if', block: 0,
        then: straight(1), els: straight(2)}, {
        cond: () => 'pick(x, trace)',
        straight: id => [`value = ${id === 1 ? taken : other};`],
        localType: name => name === 'value' ? type : null,
      }));
      assert.doesNotMatch(reconstructed, /\bif\b|\belse\b/);
      for (const [name, body] of [['original', `if (pick(x, trace)) { value = ${taken}; }
        else { value = ${other}; }`], ['rebuilt', reconstructed]]) {
        methods.push(`static String ${name}${index}(double x) {
          StringBuilder trace = new StringBuilder(); ${type} value;
          try { synchronized (trace) { ${body} trace.append('a'); }
            return receive(trace).done(before(trace), ${result}) + ":" + trace;
          } catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace; }
        }`);
      }
    });
    const source = `public class ValueBranches {
      static Boolean pick(double x, StringBuilder trace) {
        trace.append('q'); if (x == 7) throw new IllegalArgumentException();
        return Double.isNaN(x) ? null : x <= 0;
      }
      static ValueBranches receive(StringBuilder trace) { trace.append('r'); return new ValueBranches(); }
      static int before(StringBuilder trace) { trace.append('b'); return 7; }
      String done(int ignored, String result) { return result; }
      ${methods.join('\n')}
      public static void main(String[] args) {
        double[] values = {Double.NEGATIVE_INFINITY, -2147483648d, -7d, -0d, 0d,
          7d, 2147483647d, Double.POSITIVE_INFINITY, Double.NaN};
        for (double value : values) {
          ${variants.map((_, index) => `{
            String expected = original${index}(value), actual = rebuilt${index}(value);
            if (!expected.equals(actual)) throw new AssertionError(${index}+":"+value+":"+expected+":"+actual);
            System.out.println(${index}+":"+value+":"+actual);
          }`).join('\n')}
        }
      }
    }`;
    const javaFile = path.join(temporary, 'ValueBranches.java');
    fs.writeFileSync(javaFile, source);
    run('javac', ['--release', '8', '-d', temporary, javaFile], temporary);
    assert.equal(run('java', ['-cp', temporary, 'ValueBranches'], temporary)
      .trim().split('\n').length, 90);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

test('folding a value branch can shorten an enclosing return guard without reordering effects', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-nested-value-branches-'));
  try {
    const tree = {t: 'if', block: 0, then: seq(straight(1), straight(2), straight(3), straight(4)),
      els: seq({t: 'if', block: 5, then: straight(6), els: straight(7)}, straight(8))};
    const sources = {1: "trace.append('a');", 2: "trace.append('c');",
      3: "trace.append('d');", 4: 'return done(3 / divisor, trace);',
      6: 'value = 0;', 7: 'value = 1;', 8: 'return done(value / divisor, trace);'};
    const render = {cond: id => id ? 'inner(x, trace)' : 'outer(first, trace)',
      straight: id => [sources[id]], localType: name => name === 'value' ? 'int' : null};
    const folded = emitStatements(treeToStatements(tree, render));
    const previous = emitStatements(treeToStatements(tree, {...render, localType: undefined}));
    assert.match(previous, /^if \(outer\(first, trace\)\)/);
    assert.match(folded, /^if \(!\(outer\(first, trace\)\)\)/);
    assert.match(folded, /value = \(inner\(x, trace\)\) \? 0 : 1;/);
    const source = `public class NestedValueBranches {
      static boolean outer(boolean first, StringBuilder trace) { trace.append('o'); return first; }
      static Boolean inner(double x, StringBuilder trace) {
        trace.append('i'); if (x == 7) throw new IllegalArgumentException();
        return Double.isNaN(x) ? null : x <= 0;
      }
      static String done(int value, StringBuilder trace) { trace.append('r'); return value+":"+trace; }
      ${[['original', previous], ['rebuilt', folded]].map(([name, body]) => `
        static String ${name}(boolean first, double x, int divisor) {
          StringBuilder trace = new StringBuilder(); int value;
          try { ${body} } catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace; }
        }`).join('\n')}
      public static void main(String[] args) {
        double[] values = {Double.NEGATIVE_INFINITY, -2147483648d, -7d, -0d, 0d,
          7d, 2147483647d, Double.POSITIVE_INFINITY, Double.NaN};
        for (boolean first : new boolean[]{false,true}) for (double x : values)
          for (int divisor : new int[]{-1,0,1}) {
            String expected = original(first,x,divisor), actual = rebuilt(first,x,divisor);
            if (!expected.equals(actual)) throw new AssertionError(first+":"+x+":"+divisor+":"+expected+":"+actual);
            System.out.println(first+":"+x+":"+divisor+":"+actual);
          }
      }
    }`;
    const javaFile = path.join(temporary, 'NestedValueBranches.java');
    fs.writeFileSync(javaFile, source);
    run('javac', ['--release', '8', '-d', temporary, javaFile], temporary);
    assert.equal(run('java', ['-cp', temporary, 'NestedValueBranches'], temporary)
      .trim().split('\n').length, 54);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

const booleanCarrier = 'stackIn_1_0';
function promote(source, localType = name => name === 'flag' ? 'boolean' : name === 'x' ? 'double' : null) {
  return promoteBooleanStackCarriers(source, [`int ${booleanCarrier} = 0;`],
    new Map([[booleanCarrier, 'int']]), localType);
}

test('Boolean carrier proofs preserve snapshots and inline only a single adjacent pure use', () => {
  const name = booleanCarrier;
  const inline = promote(`${name} = (flag) ? 0 : 1; accept(${name} != 0);`);
  assert.deepEqual(inline.removed, [name]);
  assert.deepEqual(inline.declarations, []);
  assert.equal(inline.source.trim(), 'accept(!flag);');
  const snapshot = promote(`${name} = (pick()) ? 0 : 1; receive().accept(${name} != 0);`);
  assert.deepEqual(snapshot.promoted, [name]);
  assert.match(snapshot.source, /stackIn_1_0 = !\(pick\(\)\); receive\(\)\.accept\(stackIn_1_0\);/);
  assert.deepEqual(snapshot.declarations, ['boolean stackIn_1_0 = false;']);
  for (const source of [
    `${name} = (flag) ? 0 : 1; accept(flag = !flag, ${name} != 0);`,
    `${name} = (flag) ? 0 : 1; flag = !flag; accept(${name} != 0);`,
    `${name} = (flag) ? 0 : 1; while (${name} != 0) { flag = !flag; break; }`,
    `${name} = (flag) ? 0 : 1; accept(${name} != 0, ${name} == 0);`,
    `if (flag) { ${name} = 1; } accept(${name} != 0);`,
  ]) assert.deepEqual(promote(source).promoted, [name], source);
  const boxed = promote(`${name} = (flag) ? 0 : 1; receive().accept(${name} != 0);`,
    () => 'Boolean');
  assert.deepEqual(boxed.promoted, [name]);
  assert.match(boxed.source, /stackIn_1_0 = !\(flag\); receive\(\)\.accept\(stackIn_1_0\)/);
  const literals = promote(`${name} = 1; return 0 == ${name};`);
  assert.equal(literals.source.trim(), 'return false;');
});

test('numeric uses, shadowing, partial parses and textual lookalikes cannot retype a carrier', () => {
  const name = booleanCarrier;
  for (const source of [
    `${name} = 2; return ${name} != 0;`,
    `${name} = (flag) ? 0 : 2; return ${name} != 0;`,
    `${name} = 1; return ${name};`,
    `${name} = 1; return ${name} + 1 != 0;`,
    `${name} = 1; return ${name} != (0 + call());`,
    `${name} = 1; return ${name} != 0 * call();`,
    `${name} = 1; return ${name} != 1;`,
    `${name} = 1; ${name}++; return ${name} != 0;`,
    `accept(${name} = 1); return ${name} != 0;`,
    `if (flag) { int ${name} = 1; accept(${name} != 0); }`,
    `try { ${name} = 1; } catch (Error ${name}) { work(); } return ${name} != 0;`,
    `${name} = 1; accept(holder.${name} != 0);`,
    `${name} = 1; Object x = new Base() { boolean get() { return ${name} != 0; } };`,
    `${name} = 1; Runnable x = () -> accept(${name} != 0);`,
    `${name} = 1; return ${name} != 0; } trailing();`,
    `${name} = 1; String x = "\\u0041"; return ${name} != 0;`,
  ]) {
    const result = promote(source);
    assert.equal(result.source, source, source);
    assert.deepEqual(result.promoted, [], source);
    assert.deepEqual(result.removed, [], source);
  }
  const quoted = promote(`${name} = 1; String message = "${name} != 0"; return ${name} != 0;`);
  assert.deepEqual(quoted.promoted, [name]);
  assert.match(quoted.source, /String message = "stackIn_1_0 != 0"/);
});

test('Boolean snapshots and safe inlining match native values, failure priority and effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-boolean-carriers-'));
  try {
    const name = booleanCarrier;
    const variants = [
      `${name} = (flag) ? 0 : 1; return accept(${name} != 0, trace);`,
      `${name} = (flag) ? 1 : 0; return accept(0 == ${name}, trace);`,
      `${name} = 1; return accept(${name} == 0, trace);`,
      `${name} = (pick(x, trace)) ? 0 : 1; return receive(trace).done(before(trace), ${name} != 0, trace);`,
      `${name} = (boxed) ? 0 : 1; return receive(trace).done(before(trace), ${name} != 0, trace);`,
      `${name} = (flag) ? 0 : 1; return receive(trace).done(before(trace), (flag = !flag) && ${name} != 0, trace);`,
      `${name} = (flag) ? 0 : 1; flag = !flag; return accept(${name} != 0, trace);`,
      `${name} = (pick(x, trace)) ? 0 : 0; return accept(${name} != 0, trace);`,
      `${name} = (pick(x, trace)) ? 1 : 1; return accept(${name} == 0, trace);`,
      `if (flag) { ${name} = 1; } return accept(${name} != 0, trace);`,
      `${name} = (flag) ? 0 : 1; if (${name} != 0) return accept(true, trace); return accept(${name} == 0, trace);`,
      `${name} = (flag) ? 0 : 1; for (int i=0; i<2 && ${name} != 0; i++) { trace.append(i); flag = !flag; } return accept(flag, trace);`,
      `${name} = (x >= 0d) ? 0 : 1; return receive(trace).done(before(trace), ${name} != 0, trace);`,
      `${name} = (x < -2147483648) ? 0 : 1; return accept(${name} == 0, trace);`,
      `${name} = (x >= -9223372036854775808L) ? 1 : 0; return receive(trace).done(before(trace), (x = 1.0d) > 0 && ${name} != 0, trace);`,
    ];
    const methods = [];
    variants.forEach((original, index) => {
      const rebuilt = promote(original);
      assert.equal(rebuilt.promoted.length + rebuilt.removed.length, 1, original);
      for (const [label, declarations, body] of [['original', [`int ${name} = 0;`], original],
        ['rebuilt', rebuilt.declarations, rebuilt.source]]) {
        methods.push(`static String ${label}${index}(boolean flag,double x,Boolean boxed) {
          StringBuilder trace = new StringBuilder(); ${declarations.join('\n')}
          try { ${body} } catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace; }
        }`);
      }
    });
    const source = `public class BooleanCarriers {
      static int mode;
      static Boolean pick(double x,StringBuilder trace) {
        trace.append('q'); if (x == 7) throw new IllegalArgumentException();
        return Double.isNaN(x) ? null : x <= 0;
      }
      static BooleanCarriers receive(StringBuilder trace) {
        trace.append('r'); if (mode == 1) throw new IllegalStateException(); return new BooleanCarriers();
      }
      static int before(StringBuilder trace) {
        trace.append('b'); if (mode == 2) throw new UnsupportedOperationException(); return 7;
      }
      static String accept(boolean flag,StringBuilder trace) { trace.append('a'); return flag+":"+trace; }
      String done(int ignored,boolean flag,StringBuilder trace) { return accept(flag,trace); }
      ${methods.join('\n')}
      public static void main(String[] args) {
        for (mode=0;mode<3;mode++) for (boolean flag : new boolean[]{false,true})
          for (double x : new double[]{-0d,7d,Double.NaN}) for (Boolean boxed : new Boolean[]{false,true,null}) {
            ${variants.map((_, index) => `{
              String expected=original${index}(flag,x,boxed),actual=rebuilt${index}(flag,x,boxed);
              if (!expected.equals(actual)) throw new AssertionError(${index}+":"+mode+":"+flag+":"+x+":"+boxed+":"+expected+":"+actual);
              System.out.println(${index}+":"+mode+":"+flag+":"+x+":"+boxed+":"+actual);
            }`).join('\n')}
          }
      }
    }`;
    const javaFile=path.join(temporary,'BooleanCarriers.java');fs.writeFileSync(javaFile,source);
    run('javac',['--release','8','-d',temporary,javaFile],temporary);
    assert.equal(run('java',['-cp',temporary,'BooleanCarriers'],temporary).trim().split('\n').length,810);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('identical branch tails are factored only with complete scope and extent proofs', () => {
  const factor = source => factorCommonBranchTails(source);
  for (const source of [
    'if (pick()) { left(); finish(); return; } else { right(); finish(); return; }',
    'if (pick()) { left(); finish(); return; } right(); finish(); return;',
    'if (pick()) { if (stop()) { return; } left(); finish(); } else { right(); finish(); }',
  ]) {
    const result = factor(source);
    assert.ok(result.branches > 0, source);
    assert.equal((result.source.match(/finish\(\)/g) || []).length, 1, result.source);
  }
  const empty = factor('if (pick()) { finish(); } else { finish(); }');
  assert.match(empty.source, /if \(pick\(\)\) \{\s*\}\s*finish\(\);/);
  for (const source of [
    'if (flag) { int value = 1; use(value); } else { int value = 2; use(value); }',
    'if (flag) { class Value {} use(Value.class); } else { class Value {} use(Value.class); }',
    'if (flag) { synchronized (lock) { finish(); } } else { finish(); }',
    'if (flag) { try { finish(); } catch (RuntimeException error) { caught(); } } else { finish(); }',
    'if (flag) { finish(); } else { changed(); }',
    'if (first) { return false; } if (second) { return false; } work(); return false;',
    'if (flag) { finish(); } else { finish(); } trailing !',
    'if (flag) { finish(); } else { finish(); } // \\u000a',
  ]) assert.deepEqual(factor(source), {source, branches: 0}, source);
  const nested = factor('if (flag) { left(); if (other) { a(); finish(); } else { b(); finish(); } } else { right(); }');
  assert.ok(nested.branches > 0);
  assert.equal((nested.source.match(/finish\(\)/g) || []).length, 1);
});

test('factored tails preserve native conditions, snapshots, scopes and protected effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-shared-tails-'));
  try {
    const variants = [
      'if (pick(x,boxed,trace)) { trace.append("a"); finish(x,trace); } else { trace.append("b"); finish(x,trace); } return done(trace);',
      'if (pick(x,boxed,trace)) { finish(x,trace); return done(trace); } else { finish(x,trace); return done(trace); }',
      'if (pick(x,boxed,trace)) { trace.append("a"); finish(x,trace); return done(trace); } trace.append("b"); finish(x,trace); return done(trace);',
      'if (pick(x,boxed,trace)) { if (x == 7) { return done(trace); } trace.append("a"); finish(x,trace); } else { trace.append("b"); finish(x,trace); } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); x = -x; finish(x,trace); } else { trace.append("b"); x += 1; finish(x,trace); } return done(trace);',
      'if (pick(x,boxed,trace)) { finish(x,trace); } else { finish(x,trace); } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); if (x < 0) { synchronized (lock) { locked(x,lock,trace); } } else { trace.append("c"); synchronized (lock) { locked(x,lock,trace); } } } else { trace.append("b"); } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); try { finish(x,trace); } catch (IllegalArgumentException failure) { trace.append("c"); } } else { trace.append("b"); try { finish(x,trace); } catch (IllegalArgumentException failure) { trace.append("c"); } } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); return done(trace); } else { int value = 2; trace.append(value); return done(trace); }',
      'if (pick(x,boxed,trace)) { trace.append("a"); if (x == x) { trace.append("c"); finish(x,trace); } else { finish(x,trace); } } else { trace.append("b"); } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); if (x < 0) { trace.append("c"); finish(x,trace); } else { finish(x,trace); } } else { trace.append("b"); } return done(trace);',
      'Outer: { if (pick(x,boxed,trace)) { trace.append("a"); finish(x,trace); break Outer; } else { trace.append("b"); finish(x,trace); break Outer; } } return done(trace);',
      'for (int i=0;i<2;i++) { if (pick(x,boxed,trace)) { trace.append("a"); finish(x,trace); continue; } else { trace.append("b"); finish(x,trace); continue; } } return done(trace);',
    ];
    const methods = [];
    variants.forEach((original,index) => {
      const result = factorCommonBranchTails(original);
      if (index < 8 || index === 9 || index === 10) assert.ok(result.branches > 0, original);
      // Whole loops/labeled constructs are kept, including their inner tails.
      if (index >= 11) assert.equal(result.source, original);
      for (const [label,body] of [['original',original],['rebuilt',result.source]])
        methods.push(`static String ${label}${index}(double x,Boolean boxed,Object lock) {
          StringBuilder trace = new StringBuilder(); try { ${body} }
          catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace; }
        }`);
    });
    const source = `public class SharedTails {
      static int mode;
      static boolean pick(double x,Boolean boxed,StringBuilder trace) {
        trace.append('q'); if (mode == 1) throw new IllegalStateException();
        return mode == 2 ? boxed : x <= 0;
      }
      static void finish(double x,StringBuilder trace) {
        trace.append('f'); if (x == 7 || Double.isNaN(x)) throw new IllegalArgumentException();
        trace.append(Double.doubleToRawLongBits(x));
      }
      static void locked(double x,Object lock,StringBuilder trace) {
        if (!Thread.holdsLock(lock)) throw new AssertionError(); finish(x,trace);
      }
      static String done(StringBuilder trace) { return trace.toString(); }
      ${methods.join('\n')}
      public static void main(String[] args) {
        Object lock=new Object();
        for (mode=0;mode<3;mode++) for (double x : new double[]{Double.NEGATIVE_INFINITY,-7,-0d,0d,7,Double.POSITIVE_INFINITY,Double.NaN})
          for (Boolean boxed : new Boolean[]{false,true,null}) {
            ${variants.map((_,index)=>`{
              String expected=original${index}(x,boxed,lock),actual=rebuilt${index}(x,boxed,lock);
              if (!expected.equals(actual) || Thread.holdsLock(lock)) throw new AssertionError(${index}+":"+mode+":"+x+":"+boxed+":"+expected+":"+actual);
              System.out.println(${index}+":"+mode+":"+x+":"+boxed+":"+actual);
            }`).join('\n')}
          }
      }
    }`;
    const javaFile=path.join(temporary,'SharedTails.java');fs.writeFileSync(javaFile,source);
    run('javac',['--release','8','-d',temporary,javaFile],temporary);
    assert.equal(run('java',['-cp',temporary,'SharedTails'],temporary).trim().split('\n').length,variants.length*63);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('nested terminal clones require exact enclosing continuations and unchanged binding scopes', () => {
  const nested = 'if (outer) { before(); if (inner) { finish(); return done(); } after(); } finish(); return done();';
  const result = factorCommonBranchTails(nested);
  assert.ok(result.branches > 0);
  assert.equal((result.source.match(/finish\(\)/g) || []).length, 1);
  assert.match(result.source,/if \(outer\) \{\s+before\(\);\s+if \(!\(inner\)\) \{\s+after\(\);/);
  const labeledSource = 'touch(sharedTailExit_0); if (outer) { if (inner) { if (last) { finish(); return done(); } left(); } right(); } finish(); return done();';
  const labeled = factorCommonBranchTails(labeledSource);
  assert.ok(labeled.branches > 0);
  assert.match(labeled.source, /sharedTailExit_[1-9]\d*: \{/);
  assert.doesNotMatch(labeled.source, /sharedTailExit_0:/);
  assert.match(labeled.source, /break sharedTailExit_[1-9]\d*;/);
  for (const name of ['finish', 'done', 'left', 'right', 'touch'])
    assert.equal((labeled.source.match(new RegExp(`\\b${name}\\(`,'g')) || []).length, 1);
  assert.deepEqual(factorCommonBranchTails(labeledSource), labeled);
  for (const source of [
    'if (outer) { int value = 1; if (inner) { finish(value); return done(); } after(); } finish(value); return done();',
    'if (outer) { if (inner) { finish(); return other(); } after(); } finish(); return done();',
    'if (outer) { if (inner) { other(); return done(); } after(); } finish(); return done();',
    'if (outer) { synchronized (lock) { if (inner) { finish(); return done(); } after(); } } finish(); return done();',
    'if (outer) { try { if (inner) { finish(); return done(); } after(); } finally { cleanup(); } } finish(); return done();',
    'if (outer) { for (;;) { if (inner) { finish(); return done(); } after(); } } finish(); return done();',
    'if (outer) { Label: { if (inner) { finish(); return done(); } after(); } } finish(); return done();',
    'if (first) { return false; } if (second) { return false; } work(); return false;',
  ]) assert.deepEqual(factorCommonBranchTails(source), {source,branches:0},source);
});

test('nested continuation reconstruction matches native partial effects, failure order and scopes', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-emitter-nested-tails-'));
  try {
    const tail='finish(x,trace); return done(trace);';
    const lockTail='synchronized (lock) { locked(x,lock,trace); } return done(trace);';
    const protectedTail='try { finish(x,trace); } catch (IllegalArgumentException failure) { trace.append("c"); } finally { trace.append("z"); } return done(trace);';
    const nextTail='finish(next(x,trace),trace); return done(trace);';
    const variants=[
      `if (flag) { trace.append("a"); if (pick(x,boxed,trace)) { ${tail} } trace.append("b"); } ${tail}`,
      `touch(sharedTailExit_0,trace); if (flag) { trace.append("a"); if (pick(x,boxed,trace)) { if (x == x) { ${tail} } trace.append("i"); x++; } trace.append("b"); x=-x; } ${tail}`,
      `if (flag) { trace.append("a"); if (pick(x,boxed,trace)) { ${tail} } trace.append("b"); if (x >= 0) { ${tail} } trace.append("c"); } ${tail}`,
      `if (flag) { if (pick(x,boxed,trace)) { trace.append("a"); ${tail} } else { trace.append("b"); ${tail} } } ${tail}`,
      `if (flag) { if (pick(x,boxed,trace)) { if (x == x) { ${tail} } trace.append("b"); } trace.append("a"); } ${tail}`,
      `if (flag) { if (pick(x,boxed,trace)) { if (x < 0) { ${tail} } trace.append("b"); } trace.append("a"); } ${tail}`,
      `if (flag) { if (pick(x,boxed,trace)) { ${lockTail} } trace.append("b"); } ${lockTail}`,
      `if (flag) { if (pick(x,boxed,trace)) { ${protectedTail} } trace.append("b"); } ${protectedTail}`,
      'if (flag) { double value=x; if (pick(x,boxed,trace)) { finish(value,trace); return done(trace); } trace.append("b"); } finish(value,trace); return done(trace);',
      `if (flag) { if (pick(x,boxed,trace)) { finish(x,trace); return different(trace); } trace.append("b"); } ${tail}`,
      `if (flag) { if (pick(x,boxed,trace)) { ${nextTail} } trace.append("b"); } ${nextTail}`,
      `if (flag) { if (pick(x,boxed,trace)) { if (counter++ == 0) { ${nextTail} } trace.append("i"); } trace.append("b"); } ${nextTail}`,
      `if (flag) { if (pick(x,boxed,trace)) { if (counter++ == 0) { ${tail} } trace.append("i"); counter++; } before(x,trace); } ${tail}`,
      `if (flag) { before(x,trace); if (pick(x,boxed,trace)) { ${tail} } before(-x,trace); } ${tail}`,
      'if (flag) { if (pick(x,boxed,trace)) { if (x == x) { trace.append("f"); throw sentinel; } trace.append("i"); } trace.append("b"); } trace.append("f"); throw sentinel;',
    ];
    const methods=[];
    variants.forEach((original,index)=>{
      const result=factorCommonBranchTails(original);
      if (![8,9].includes(index)) assert.ok(result.branches > 0,original);
      if ([8,9].includes(index)) assert.equal(result.source,original);
      if (index === 1) {
        assert.match(result.source, /sharedTailExit_[1-9]\d*:/);
        assert.doesNotMatch(result.source, /sharedTailExit_0:/);
      }
      for (const [label,body] of [['original',original],['rebuilt',result.source]])
        methods.push(`static String ${label}${index}(boolean flag,double x,Boolean boxed,Object lock) {
          StringBuilder trace=new StringBuilder(); try { ${body} }
          catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace+":"+(failure == sentinel); }
        }`);
    });
    const source=`public class NestedTails {
      static int mode,counter; static double value=3;
      static int sharedTailExit_0=7;
      static final IllegalStateException sentinel=new IllegalStateException();
      static void touch(int value,StringBuilder trace) { trace.append('v').append(value); }
      static boolean pick(double x,Boolean boxed,StringBuilder trace) {
        trace.append('q'); if (mode == 1) throw new IllegalStateException();
        return mode == 2 ? boxed : x <= 0;
      }
      static void before(double x,StringBuilder trace) {
        trace.append('b'); if (x == 7) throw new IllegalArgumentException();
      }
      static double next(double x,StringBuilder trace) {
        trace.append('n'); counter++; if (counter > 1) throw new IndexOutOfBoundsException(); return x;
      }
      static void finish(double x,StringBuilder trace) {
        trace.append('f'); if (x == 7 || Double.isNaN(x)) throw new IllegalArgumentException();
        trace.append(Double.doubleToRawLongBits(x));
      }
      static void locked(double x,Object lock,StringBuilder trace) {
        if (!Thread.holdsLock(lock)) throw new AssertionError(); finish(x,trace);
      }
      static String done(StringBuilder trace) {
        trace.append('d'); if (mode == 3) throw new UnsupportedOperationException(); return trace.toString();
      }
      static String different(StringBuilder trace) { trace.append('!'); return done(trace); }
      ${methods.join('\n')}
      public static void main(String[] args) {
        Object lock=new Object();
        for (mode=0;mode<4;mode++) for (boolean flag:new boolean[]{false,true})
          for (double x:new double[]{Double.NEGATIVE_INFINITY,-7,-0d,0d,7,Double.POSITIVE_INFINITY,Double.NaN})
            for (Boolean boxed:new Boolean[]{false,true,null}) {
              ${variants.map((_,index)=>`{
                counter=0; String expected=original${index}(flag,x,boxed,lock); int expectedCounter=counter;
                counter=0; String actual=rebuilt${index}(flag,x,boxed,lock);
                if (!expected.equals(actual) || counter != expectedCounter || Thread.holdsLock(lock))
                  throw new AssertionError(${index}+":"+mode+":"+flag+":"+x+":"+boxed+":"+expected+":"+actual+":"+expectedCounter+":"+counter);
                System.out.println(${index}+":"+mode+":"+flag+":"+x+":"+boxed+":"+actual+":"+counter);
              }`).join('\n')}
            }
      }
    }`;
    const javaFile=path.join(temporary,'NestedTails.java');fs.writeFileSync(javaFile,source);
    run('javac',['--release','8','-d',temporary,javaFile],temporary);
    assert.equal(run('java',['-cp',temporary,'NestedTails'],temporary).trim().split('\n').length,2520);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('integral predicate facts reuse cached operands and discard both sides of ambiguous complements', () => {
  const {integralConditionsFromCache} = require('../src/decompiler/cfr')._internals;
  const state = (code, integralComparison) => ({terminator:{op:'ifne'},
    branchCondition:{code,type:'boolean',precedence:60,integralComparison}});
  const cache = new Map([[0,state('count >= 7',true)], [1,state('value < limit',true)],
    [2,state('floating < limit',false)], [3,state('value < limit',false)]]);
  assert.deepEqual([...integralConditionsFromCache(cache)].sort(), ['count < 7','count >= 7']);
  const operands = [{code:'left()',type:'int',precedence:90}, {code:'right()',type:'int',precedence:90}];
  const bytecodeState={terminator:{op:'if_icmpge'},stack:operands};
  const before=JSON.stringify(bytecodeState);
  assert.deepEqual([...integralConditionsFromCache(new Map([[0,bytecodeState]]))].sort(),
    ['left() < right()','left() >= right()']);
  assert.equal(JSON.stringify(bytecodeState),before);
  assert.equal(integralConditionsFromCache(new Map([[0,state('a >= b',true)],
    [1,state('a < b',false)]])).size,0);
  const source='if (outer) { if (count >= 7) { finish(); return done(); } step(); } finish(); return done();';
  assert.match(factorCommonBranchTails(source).source,/!\(count >= 7\)/);
  const typed=factorCommonBranchTails(source,{integralConditions:new Set(['count >= 7'])});
  assert.match(typed.source,/if \(count < 7\)/);
  assert.equal((typed.source.match(/finish\(\)/g)||[]).length,1);
});

test('plain block tails keep scopes and coalesce exits without assuming opaque loop completion', () => {
  const source = '{ if (task != null) { L2: while (task.status == 0) { waitForTask(); } if (joinNeeded) { try { join(); decompiledRegionSelector0 = 0; } catch (InterruptedException error) { decompiledRegionSelector0 = 1; } if (decompiledRegionSelector0 == 0) { task = null; return; } } } task = null; return; }';
  const factored = factorCommonBranchTails(source);
  assert.ok(factored.branches > 0);
  assert.equal(factored.source.match(/task = null;/g).length, 1);
  assert.match(factored.source, /L2: while \(task.status == 0\) \{ waitForTask\(\); \}/);
  assert.match(factored.source, /try \{ join\(\); decompiledRegionSelector0 = 0; \} catch \(InterruptedException error\) \{ decompiledRegionSelector0 = 1; \}/);
  assert.doesNotMatch(factored.source, /sharedTailExit_/);
  const cleaned = removeDeadRegionSelectors(factored.source, ['int decompiledRegionSelector0 = 0;'], ['decompiledRegionSelector0']);
  assert.deepEqual(cleaned.removed, ['decompiledRegionSelector0']);
  assert.doesNotMatch(cleaned.source, /decompiledRegionSelector/);
  const skipped = factorCommonBranchTails('{ if (flag) { while (true) { if (stop()) break; } if (pick()) { finish(); return; } before(); } after(); finish(); return; }');
  assert.equal(skipped.source.match(/finish\(\);/g).length, 1);
  assert.match(skipped.source, /sharedTailExit_\d+:/);
  // The skip must remain: returning before these effects originally skipped them.
  assert.match(skipped.source, /break sharedTailExit_\d+;/);
  const largePrefix = '{ if (flag) { if (pick()) { finish(); return; } before(); } '
    + 'after(); '.repeat(300) + 'finish(); return; }';
  assert.equal(factorCommonBranchTails(largePrefix).source, largePrefix);
  for (const opaque of [
    'try { if (flag) { finish(); return; } finish(); return; } catch (Exception error) { return; }',
    'synchronized (lock) { if (flag) { finish(); return; } finish(); return; }',
    'while (true) { if (flag) { finish(); return; } finish(); return; }',
    'Existing: { if (flag) { finish(); return; } finish(); return; }',
  ]) assert.equal(factorCommonBranchTails(opaque).source, opaque);
  const shadowed = '{ if (flag) { int value = 7; finish(value); return value; } finish(value); return value; }';
  const scoped = factorCommonBranchTails(shadowed);
  assert.equal(scoped.branches, 0);
  assert.equal(scoped.source, shadowed);
});

test('plain block tail recovery matches native scopes, loop skips and protected failures', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-plain-block-tails-'));
  try {
    const tail = 'finish(trace); return done(trace);';
    const variants = [
      `{{ if (flag) { if (pick(boxed,trace)) { ${tail} } before(trace); } ${tail} }}`,
      `{ if (flag) { L2: while (loop(trace)) {} if (pick(boxed,trace)) {
         try { join(trace); decompiledRegionSelector0 = 0; }
         catch (InterruptedException error) { trace.append('c'); decompiledRegionSelector0 = 1; }
         if (decompiledRegionSelector0 == 0) { ${tail} }
       } } ${tail} }`,
      `{ if (flag) { L2: while (true) { if (loop(trace)) break L2; }
         if (pick(boxed,trace)) { ${tail} } before(trace); }
         trace.append('a'); ${tail} }`,
      `{ if (flag) { int value = 7; if (pick(boxed,trace)) { trace.append(value); return done(trace); } }
         trace.append(value); return done(trace); }`,
      `{ if (flag) { try { before(trace); } finally { trace.append('f'); if (mode == 5) throw fatal; }
         if (pick(boxed,trace)) { ${tail} } } ${tail} }`,
      `{ if (flag) { synchronized (lock) { trace.append(Thread.holdsLock(lock)); before(trace); }
         if (pick(boxed,trace)) { ${tail} } } ${tail} }`,
    ];
    const methods = [];
    variants.forEach((original, index) => {
      const factored = factorCommonBranchTails(original);
      if (index !== 3) assert.ok(factored.branches > 0);
      const cleaned = removeDeadRegionSelectors(factored.source,
        ['int decompiledRegionSelector0 = 0;'], ['decompiledRegionSelector0']);
      assert.deepEqual(cleaned.removed, ['decompiledRegionSelector0']);
      for (const [label, body] of [['original', 'int decompiledRegionSelector0 = 0;\n' + original],
        ['rebuilt', cleaned.source]]) methods.push(`static String ${label}${index}(boolean flag,Boolean boxed) throws Throwable { ${body} }`);
    });
    const source = `public class PlainBlockTails {
      static int mode,value=30,loopCalls; static Object lock; static StringBuilder trace;
      static final InterruptedException interrupted=new InterruptedException();
      static final IllegalStateException general=new IllegalStateException(); static final Error fatal=new Error();
      static boolean loop(StringBuilder trace) { trace.append('l'); return ++loopCalls % 2 == 0; }
      static boolean pick(Boolean boxed,StringBuilder trace) { trace.append('p'); if(mode==3)throw fatal; return boxed; }
      static void before(StringBuilder trace) { trace.append('b'); if(mode==2)throw general; }
      static void join(StringBuilder trace) throws InterruptedException { trace.append('j'); if(mode==1)throw interrupted; }
      static void finish(StringBuilder trace) throws InterruptedException {
        trace.append('x').append(lock!=null && Thread.holdsLock(lock)); if(mode==4)throw interrupted;
      }
      static String done(StringBuilder trace) { return "done:"+trace; }
      ${methods.join('\n')}
      interface Call { String call() throws Throwable; }
      static String invoke(Call call,boolean nullLock) {
        trace=new StringBuilder();loopCalls=0;lock=nullLock?null:new Object();String result;
        try {result=call.call();}catch(Throwable error) {
          result=error==interrupted?"same-interrupted":error==general?"same-general":error==fatal?"same-fatal":error.getClass().getName();
        }
        if(lock!=null && Thread.holdsLock(lock))throw new AssertionError("monitor retained");
        return result+":"+trace+":"+loopCalls;
      }
      public static void main(String[]args) {
        for(mode=0;mode<6;mode++)for(boolean flag:new boolean[]{false,true})
        for(Boolean boxed:new Boolean[]{null,false,true})for(boolean nullLock:new boolean[]{false,true}) {
          ${variants.map((_,index)=>`{
            String expected=invoke(()->original${index}(flag,boxed),nullLock),actual=invoke(()->rebuilt${index}(flag,boxed),nullLock);
            if(!expected.equals(actual))throw new AssertionError(${index}+":"+mode+":"+flag+":"+boxed+":"+nullLock+":"+expected+":"+actual);
            System.out.println(${index}+":"+actual);
          }`).join('\n')}
        }
      }
    }`;
    const file = path.join(temporary, 'PlainBlockTails.java'); fs.writeFileSync(file, source);
    run('javac', ['--release', '8', '-d', temporary, file], temporary);
    assert.equal(run('java', ['-cp', temporary, 'PlainBlockTails'], temporary).trim().split('\n').length, 432);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

test('typed integral tail guards preserve native boundaries, unboxing, NaNs and operand failure order', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-emitter-typed-tail-guards-'));
  try {
    const variants=[];
    for (const [operator,opposite] of [['>=','<'],['>','<='],['<','>='],['<=','>']]) {
      const condition=`left(x,trace) ${operator} right(y,trace)`;
      const source=`if (flag) { if (${condition}) { finish(trace); return done(trace); } before(trace); } finish(trace); return done(trace);`;
      variants.push({source,condition,opposite,kind:'typed'});
    }
    variants.push({kind:'unknown',source:'if (flag) { if (floating < 0d) { finish(trace); return done(trace); } before(trace); } finish(trace); return done(trace);'});
    variants.push({kind:'unknown',source:'if (flag) { if (boxed >= y) { finish(trace); return done(trace); } before(trace); } finish(trace); return done(trace);'});
    const methods=[];
    variants.forEach((variant,index)=>{
      const integralConditions=new Set(variant.condition?[variant.condition]:[]);
      const rebuilt=factorCommonBranchTails(variant.source,{integralConditions});
      assert.ok(rebuilt.branches > 0);
      if (variant.kind==='typed') assert.ok(rebuilt.source.includes(`left(x,trace) ${variant.opposite} right(y,trace)`));
      else assert.match(rebuilt.source,/!\(/);
      for (const [label,body] of [['original',variant.source],['rebuilt',rebuilt.source]])
        methods.push(`static String ${label}${index}(boolean flag,long x,long y,double floating,Long boxed) {
          StringBuilder trace=new StringBuilder(); try { ${body} }
          catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace; }
        }`);
    });
    const source=`public class TypedTailGuards {
      static int mode;
      static long left(long value,StringBuilder trace) { trace.append('l'); if(mode==1)throw new IllegalStateException();return value; }
      static long right(long value,StringBuilder trace) { trace.append('r'); if(mode==2)throw new IllegalArgumentException();return value; }
      static void before(StringBuilder trace) { trace.append('b'); if(mode==3)throw new UnsupportedOperationException(); }
      static void finish(StringBuilder trace) { trace.append('f'); }
      static String done(StringBuilder trace) { return trace.toString(); }
      ${methods.join('\n')}
      public static void main(String[] args) {
        long[] integers={Long.MIN_VALUE,Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE,Long.MAX_VALUE};
        double[] reals={Double.NEGATIVE_INFINITY,-0d,0d,Double.POSITIVE_INFINITY,Double.NaN};
        for(mode=0;mode<4;mode++)for(boolean flag:new boolean[]{false,true})for(long x:integers)for(long y:integers)
          for(double floating:reals)for(Long boxed:new Long[]{null,-1L,Long.MAX_VALUE}) {
            ${variants.map((_,index)=>`{
              String expected=original${index}(flag,x,y,floating,boxed),actual=rebuilt${index}(flag,x,y,floating,boxed);
              if(!expected.equals(actual))throw new AssertionError(${index}+":"+mode+":"+flag+":"+x+":"+y+":"+floating+":"+boxed+":"+expected+":"+actual);
              System.out.println(${index}+":"+actual);
            }`).join('\n')}
          }
      }
    }`;
    const javaFile=path.join(temporary,'TypedTailGuards.java');fs.writeFileSync(javaFile,source);
    run('javac',['--release','8','-d',temporary,javaFile],temporary);
    assert.equal(run('java',['-cp',temporary,'TypedTailGuards'],temporary).trim().split('\n').length,35280);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});


test('unread receiver snapshot cleanup requires allocator identities and complete safe stores', () => {
  const name='stackIn_2_0', declaration=`Object ${name} = null;`;
  const source=`trace.append("${name}"); // ${name}
if(pick()) { ${name} = this; work(); } else { ${name} = null; }
try { ${name} = this; fail(); } catch(Exception error) { ${name} = this; caught(error); }
synchronized(lock) { ${name} = null; finish(); }`;
  const result=removeDeadReceiverSnapshots(source,[declaration,'int count = 0;'],[name]);
  assert.deepEqual(result.removed,[name]);assert.deepEqual(result.declarations,['int count = 0;']);
  assert.equal(result.source,`trace.append("${name}"); // ${name}
if(pick()) {  work(); } else {  }
try {  fail(); } catch(Exception error) {  caught(error); }
synchronized(lock) {  finish(); }`);
  for(const [declarations,names] of [[[declaration],[]],[[declaration,declaration],[name]],
    [[`Thing ${name} = null;`],[name]],[[`Object ${name};`],[name]]])
    assert.equal(removeDeadReceiverSnapshots(source,declarations,names).source,source);
  for(const body of [
    `${name}=this; return ${name};`, `${name}=effect();`, `${name}=other;`, `${name}=new Object();`,
    `${name}=this.field;`, `${name}=(Object)this;`, `${name}=Outer.this;`, `${name}=this; use(other.${name});`,
    `${name}=this; use(${name});`, `${name}=this; Object alias=${name};`, `${name}=(${name}=this);`,
    `{ Object ${name}=null; ${name}=this; }`, `if(pick()) ${name}=this;`, `label: ${name}=null;`,
    `${name}=this; unknown @ syntax;`, `${name}=this; /* \\u0061 */`,
    `${name}=this; } return; {`, `for(${name}=this; false;) {}`,
  ]) {
    const refused=removeDeadReceiverSnapshots(body,[declaration],[name]);
    assert.equal(refused.source,body,body);assert.deepEqual(refused.removed,[],body);
  }
  assert.equal(removeDeadReceiverSnapshots(source,[declaration,`Object alias=${name};`],[name]).source,source);
  const mixed=`${source}\nstackIn_3_0 = this; return stackIn_3_0;`;
  assert.deepEqual(removeDeadReceiverSnapshots(mixed,[declaration,'Object stackIn_3_0 = null;'],[name,'stackIn_3_0']).removed,[name]);
});

test('receiver snapshot cleanup preserves native effects, failures, catch/finally and lock scope', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-dead-receiver-'));
  try {
    const name='stackIn_2_0', declaration=`Object ${name} = null;`;
    const body=`try {
      if(branch()) { ${name}=this; work(mode); } else { ${name}=null; work(mode); }
      synchronized(lock) { ${name}=this; trace.append(Thread.holdsLock(lock)); work(mode); }
    } catch(IllegalArgumentException error) { ${name}=this; trace.append(error==specific); }
      catch(RuntimeException error) { ${name}=null; trace.append(error==general); }
      finally { ${name}=this; trace.append('f'); work(finalFailure); }
    trace.append('e');`;
    const result=removeDeadReceiverSnapshots(body,[declaration],[name]);
    assert.deepEqual(result.removed,[name]);
    const source=`public class ReceiverSnapshots {
      static final RuntimeException specific=new IllegalArgumentException(),general=new IllegalStateException();
      static final Error fatal=new AssertionError();static Object lock;static StringBuilder trace;static int branchMode;
      static boolean branch(){trace.append('b');if(branchMode==2)throw general;return branchMode!=0;}
      static void work(int mode){trace.append('w');if(mode==1)throw specific;if(mode==2)throw general;if(mode==3)throw fatal;}
      void original(int mode,int finalFailure){${declaration}\n${body}}
      void rebuilt(int mode,int finalFailure){${result.source}}
      static String invoke(boolean rebuild,int mode,int finalFailure,int branch,boolean nullLock) {
        trace=new StringBuilder();lock=nullLock?null:new Object();branchMode=branch;String escaped="ok";
        try{if(rebuild)new ReceiverSnapshots().rebuilt(mode,finalFailure);else new ReceiverSnapshots().original(mode,finalFailure);}
        catch(Throwable error){escaped=error==specific?"specific":error==general?"general":error==fatal?"fatal":error.getClass().getName();}
        if(lock!=null && Thread.holdsLock(lock))throw new AssertionError("monitor escaped");return escaped+":"+trace;
      }
      public static void main(String[] args){int cases=0;
        for(int mode=0;mode<4;mode++)for(int finalFailure=0;finalFailure<4;finalFailure++)
        for(int branch=0;branch<3;branch++)for(boolean nullLock:new boolean[]{false,true}){
          String expected=invoke(false,mode,finalFailure,branch,nullLock),actual=invoke(true,mode,finalFailure,branch,nullLock);
          if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);
          System.out.println(mode+":"+finalFailure+":"+branch+":"+nullLock+":"+actual);cases++;
        }if(cases!=96)throw new AssertionError("case count");
      }
    }`;
    const file=path.join(temporary,'ReceiverSnapshots.java');fs.writeFileSync(file,source);
    run('javac',['--release','8','-d',temporary,file],temporary);
    assert.equal(run('java',['-cp',temporary,'ReceiverSnapshots'],temporary).trim().split('\n').length,96);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});


test('value branches fold proven primitive locals without widening or boxing',()=>{
  const renderPair=(taken,other,types) => emitStatements(treeToStatements({
    t:'if',block:0,then:straight(1),els:straight(2),
  },{cond:()=> 'pick()',straight:id=>[id===1?taken:other],localType:name=>types[name]??null}));
  for(const type of ['boolean','byte','char','short','int','long','float','double']) {
    const result=renderPair('value = left;', 'value = right;', {value:type,left:type,right:type});
    assert.equal(result,'value = (pick()) ? left : right;');
  }
  assert.equal(renderPair('value = -1;', 'value = input;', {value:'int',input:'int'}),'value = (pick()) ? -1 : input;');
  for(const [taken,other,types] of [
    ['value = 0;', 'value = input;',{value:'byte',input:'byte'}],
    ['value = left;', 'value = right;',{value:'double',left:'int',right:'double'}],
    ['value = left;', 'value = right;',{value:'long',left:'int',right:'long'}],
    ['value = left;', 'value = right;',{value:'boolean',left:'Boolean',right:'Boolean'}],
    ['value = 0;', 'value = field;',{value:'int'}],
    ['value = left;', 'value = right;',{value:'String',left:'String',right:'String'}],
    ['value = 0;', 'value = Owner.field;',{value:'int'}],
    ['value = 0;', 'value = array[0];',{value:'int'}],
    ['value = 0;', 'value = next();',{value:'int'}],
    ['value = 0;', 'value = input++;',{value:'int',input:'int'}],
  ]) assert.match(renderPair(taken,other,types),/else/);
});

test('primitive-local joins preserve native values, condition effects and failures',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-primitive-local-joins-'));
  try {
    const cases=[
      {type:'int',zero:'0',values:'new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE}',size:5},
      {type:'long',zero:'0L',values:'new long[]{Long.MIN_VALUE,-1L,0L,1L,Long.MAX_VALUE}',size:5},
      {type:'float',zero:'0.0f',values:'new float[]{Float.NEGATIVE_INFINITY,-0.0f,0.0f,1.0f,Float.MAX_VALUE,Float.MIN_VALUE,Float.POSITIVE_INFINITY,Float.intBitsToFloat(0x7fc01234),Float.intBitsToFloat(0xffc01234)}',size:9},
      {type:'double',zero:'0.0',values:'new double[]{Double.NEGATIVE_INFINITY,-0.0,0.0,1.0,Double.MAX_VALUE,Double.MIN_VALUE,Double.POSITIVE_INFINITY,Double.longBitsToDouble(0x7ff8000000001234L),Double.longBitsToDouble(0xfff8000000001234L)}',size:9},
      {type:'boolean',zero:'false',values:'new boolean[]{false,true}',size:2},
      {type:'byte',zero:'0',values:'new byte[]{Byte.MIN_VALUE,-1,0,1,Byte.MAX_VALUE}',size:5},
      {type:'short',zero:'0',values:'new short[]{Short.MIN_VALUE,-1,0,1,Short.MAX_VALUE}',size:5},
      {type:'char',zero:'0',values:'new char[]{0,1,127,32768,65535}',size:5},
    ];
    const methods=[],drivers=[];let expectedCases=0;
    for(const [index,fixture] of cases.entries()) {
      const {type,zero,values,size}=fixture;
      const bits=type==='float'?'Float.floatToRawIntBits(value)':type==='double'?'Double.doubleToRawLongBits(value)':type==='char'?'(int)value':'value';
      const variants=[['left','right'],...(['int','long','float','double','boolean'].includes(type)?[[zero,'right']]:[])];
      for(const [variant,[left,right]] of variants.entries()) {
        const name=index+'_'+variant;const original=`if(pick(flag,boxed,trace)){value = ${left};} else {value = ${right};}`;
        const rebuilt=emitStatements(treeToStatements({t:'if',block:0,then:straight(1),els:straight(2)}, {
          cond:()=> 'pick(flag,boxed,trace)',straight:id=>[`value = ${id===1?left:right};`],
          localType:variable=>['value','left','right'].includes(variable)?type:null,
        }));assert.doesNotMatch(rebuilt,/else/);
        const post=factorCommonBranchTails(original,{localType:variable=>['value','left','right'].includes(variable)?type:null});
        assert.ok(post.branches>0);assert.doesNotMatch(post.source,/else/);
        for(const [label,body] of [['original',original],['rebuilt',rebuilt],['post',post.source]]) methods.push(`static String ${label}${name}(boolean flag,${type} left,${type} right,Boolean boxed) {
          ${type} value=${zero};StringBuilder trace=new StringBuilder();String outcome="ok";
          try {${body}} catch(RuntimeException error){outcome=error.getClass().getName()+":"+(error==failure);}
          finally {trace.append('f').append(${bits});}
          return outcome+":"+trace+":"+${bits};
        }`);
        drivers.push(`for(${type} left:${variant?'new '+type+'[]{'+zero+'}':values}) for(${type} right:${values}) for(boolean flag:new boolean[]{false,true})
          for(Boolean boxed:new Boolean[]{false,true,null}) for(mode=0;mode<3;mode++) {
            String expected=original${name}(flag,left,right,boxed),actual=rebuilt${name}(flag,left,right,boxed),post=post${name}(flag,left,right,boxed);
            if(!expected.equals(actual)||!expected.equals(post))throw new AssertionError("${name}:"+expected+" != "+actual+" / "+post);System.out.println("${name}:"+actual);
          }`);expectedCases+=(variant?1:size)*size*18;
      }
    }
    const source=`public class PrimitiveJoins {
      static int mode;static final RuntimeException failure=new IllegalStateException();
      static boolean pick(boolean flag,Boolean boxed,StringBuilder trace) {
        trace.append('q');if(mode==1)throw failure;return mode==2?boxed:flag;
      }
      ${methods.join('\n')}
      public static void main(String[] args){${drivers.join('\n')}}
    }`;
    const file=path.join(temporary,'PrimitiveJoins.java');fs.writeFileSync(file,source);
    run('javac',['--release','8','-d',temporary,file],temporary);
    assert.equal(run('java',['-cp',temporary,'PrimitiveJoins'],temporary).trim().split('\n').length,expectedCases);
    assert.equal(expectedCases,5778);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});


test('post-cleanup primitive joins require unshadowed proven local types',()=>{
  const source='if(flag) { value = -1; } else { value = input; }';
  const types=name=>['value','input'].includes(name)?'int':null;
  assert.equal(factorCommonBranchTails(source,{localType:types}).source,'value = (flag) ? -1 : input;');
  for(const body of [
    'int input=7; '+source,
    'if(outer) { byte input=7; '+source+' }',
    'try { '+source+' } catch(Exception error) { fail(); }',
    'synchronized(lock) { '+source+' }',
    'while(flag) { '+source+' }',
    'scope: { '+source+' }',
  ]) assert.deepEqual(factorCommonBranchTails(body,{localType:types}),{source:body,branches:0});
});
