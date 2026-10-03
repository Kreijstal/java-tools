'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {treeToStatements, emitStatements, promoteBooleanStackCarriers, factorCommonBranchTails,
  removeDeadRegionSelectors, removeDeadReceiverSnapshots, factorLabeledBlockReturnTails,
  simplifyControlFrames, removeFallthroughLabelBreaks, foldLabeledBooleanDecisions, foldVoidReturnExits, foldNestedIfGuards, foldLabeledSkipGuards, foldLabeledIfElseExits} = require('../src/decompiler/javaAstEmitter');
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

test('existing exit blocks share terminal clones across loops without crossing protected scopes', () => {
  const source = 'Exit: { while (again) { if (stop) { publish(); return; } step(); } } publish(); return;';
  const factored = factorLabeledBlockReturnTails(source);
  assert.equal(factored.branches, 1);
  assert.equal(factored.source, 'Exit: { while (again) { if (stop) { break Exit; } step(); } } publish(); return;');
  assert.deepEqual(factorLabeledBlockReturnTails(factored.source), {source:factored.source,branches:0});
  for (const source of [
    'Exit: { try { publish(); return; } finally { cleanup(); } } publish(); return;',
    'Exit: { try { publish(); return; } catch (RuntimeException error) { recover(); } } publish(); return;',
    'Exit: { synchronized (lock) { publish(); return; } } publish(); return;',
    'Exit: { if (stop) { int value=1; publish(value); return value; } } publish(value); return value;',
    'Exit: { if (stop) { int value=1; publish(); return; } } int value=1; publish(); return;',
    'Exit: { if (stop) { publish(); return other(); } } publish(); return done();',
    'Exit: { if (stop) { other(); return done(); } } publish(); return done();',
    'Exit: { if (stop) { return; } } return;',
    'Exit: while (again) { if (stop) { publish(); return; } } publish(); return;',
    'Exit: { if (stop) { publish(); /* retained */ return; } } publish(); return;',
    'Exit: { if (stop) { publish("\\u0061"); return; } } publish("\\u0061"); return;',
  ]) assert.deepEqual(factorLabeledBlockReturnTails(source), {source,branches:0},source);
  const protectedInside = 'try { Exit: { while (again) { if (stop) { publish(); return; } step(); } } publish(); return; } catch (RuntimeException error) { recover(); }';
  const inside = factorLabeledBlockReturnTails(protectedInside);
  assert.equal(inside.branches, 1);
  assert.match(inside.source, /try \{ Exit: \{ while/);
  assert.match(inside.source, /break Exit;/);
  const multiple = 'Exit: { Left: while (a) { if (stop) { publish(); return; } break Left; } Right: { if (stop) { publish(); return; } } } publish(); return;';
  assert.equal(factorLabeledBlockReturnTails(multiple).branches, 2);
  const enclosingLocal = 'int value=7; Exit: { while (again) { if (stop) { publish(value); return value; } step(); } } publish(value); return value;';
  assert.equal(factorLabeledBlockReturnTails(enclosingLocal).branches, 1);
});

test('existing exit-block cleanup matches native loop effects, failures and monitor ownership', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-existing-exit-tails-'));
  try {
    const tail='finish(x,trace); return done(trace);';
    const variants=[
      `Exit: { if (flag) { ${tail} } before(x,trace); } ${tail}`,
      `Exit: { while (counter < 5) { trace.append('w'); if (counter++ == stop) { ${tail} } if (flag) continue; before(x,trace); } } ${tail}`,
      `Exit: { for (int index=0;index<5;index++) { counter++; if (index == stop) { ${tail} } if (flag) continue; before(x,trace); } } ${tail}`,
      `Exit: { do { trace.append('o'); if (counter++ == stop) { ${tail} } if (flag) break; before(x,trace); } while (counter < 5); } ${tail}`,
      `Exit: { for (int entry : new int[]{0,1,2,3,4}) { counter++; if (entry == stop) { ${tail} } before(x,trace); } } ${tail}`,
      `Exit: { Inner: { for (int index=0;index<5;index++) { counter++; if (flag && index == stop) { ${tail} } if (index == 3) break Inner; before(x,trace); } } trace.append('b'); } ${tail}`,
      'synchronized (lock) { Exit: { while (counter < 5) { if (counter++ == stop) { locked(x,lock,trace); return done(trace); } before(x,trace); } } locked(x,lock,trace); return done(trace); }',
      `try { Exit: { while (counter < 5) { if (counter++ == stop) { ${tail} } before(x,trace); } } ${tail} } catch (IllegalArgumentException failure) { trace.append('c'); return done(trace); } finally { trace.append('z'); counter++; }`,
      `Exit: { while (counter < 5) { if (counter++ == stop) { try { ${tail} } finally { trace.append('z'); counter++; } } before(x,trace); } } ${tail}`,
      'Exit: { while (counter < 5) { if (counter++ == stop) { synchronized (lock) { locked(x,lock,trace); return done(trace); } } before(x,trace); } } locked(x,lock,trace); return done(trace);',
      `Exit: { while (counter < 5) { if (counter++ == stop) { if (flag) { try { ${tail} } finally { trace.append('z'); } } ${tail} } before(x,trace); } } ${tail}`,
      "Exit: { while (counter < 5) { if (counter++ == stop) { trace.append('f'); throw sentinel; } before(x,trace); } } trace.append('f'); throw sentinel;",
      'Exit: { if (flag) { double value=x; finish(value,trace); return done(trace); } before(x,trace); } finish(value,trace); return done(trace);',
      `Exit: { if (flag) { ${tail} } ${'counter += 0; '.repeat(150)} before(x,trace); } ${tail}`,
      `Exit: { while (counter < 5) { if (counter++ == stop) { finish(x,trace); return other(trace); } before(x,trace); } } ${tail}`,
      `int saved=stop; Exit: { while (counter < 5) { if (counter++ == stop) { trace.append(saved); ${tail} } before(x,trace); } } trace.append(saved); ${tail}`,
    ];
    const methods=[];
    variants.forEach((original,index)=>{
      const result=factorLabeledBlockReturnTails(original);
      if ([8,9,12,14].includes(index)) assert.equal(result.branches,0,original);
      else assert.ok(result.branches > 0,original);
      assert.doesNotMatch(result.source, /sharedTailExit_/);
      assert.deepEqual(factorLabeledBlockReturnTails(result.source), {source:result.source,branches:0});
      for (const [label,body] of [['original',original],['rebuilt',result.source]])
        methods.push(`static String ${label}${index}(boolean flag,int stop,double x,Object lock) {
          StringBuilder trace=new StringBuilder(); try { ${body} }
          catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace+":"+(failure == sentinel); }
        }`);
    });
    const source=`public class ExistingExitTails {
      static int mode,counter; static double value=3;
      static final IllegalStateException sentinel=new IllegalStateException();
      static void before(double x,StringBuilder trace) { trace.append('b'); if (mode == 1 && x == 7) throw new IndexOutOfBoundsException(); }
      static void finish(double x,StringBuilder trace) { trace.append('f'); if (mode == 2 && Double.isNaN(x)) throw new IllegalArgumentException(); trace.append(Double.doubleToRawLongBits(x)); }
      static void locked(double x,Object lock,StringBuilder trace) { trace.append(Thread.holdsLock(lock)?'l':'u'); finish(x,trace); }
      static String done(StringBuilder trace) { trace.append('d'); if (mode == 3) throw sentinel; return trace.toString(); }
      static String other(StringBuilder trace) { trace.append('!'); return done(trace); }
      ${methods.join('\n')}
      public static void main(String[] args) {
        Object lock=new Object();
        for (mode=0;mode<4;mode++) for (boolean flag:new boolean[]{false,true})
          for (int stop:new int[]{0,2,4,7}) for (double x:new double[]{-1,-0d,7,Double.NaN}) {
            ${variants.map((_,index)=>`{
              counter=0; String expected=original${index}(flag,stop,x,lock); int expectedCounter=counter;
              counter=0; String actual=rebuilt${index}(flag,stop,x,lock);
              if (!expected.equals(actual) || counter != expectedCounter || Thread.holdsLock(lock))
                throw new AssertionError(${index}+":"+mode+":"+flag+":"+stop+":"+x+":"+expected+":"+actual+":"+expectedCounter+":"+counter);
              System.out.println(${index}+":"+mode+":"+flag+":"+stop+":"+x+":"+actual+":"+counter);
            }`).join('\n')}
          }
      }
    }`;
    const file=path.join(temporary,'ExistingExitTails.java');fs.writeFileSync(file,source);
    run('javac',['--release','8','-d',temporary,file],temporary);
    assert.equal(run('java',['-cp',temporary,'ExistingExitTails'],temporary).trim().split('\n').length,2048);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('control frames require exact Java jump destinations and preserve declaration scopes', () => {
  const simple='Loop: while (again) { if (stop) break Loop; continue Loop; }';
  assert.deepEqual(simplifyControlFrames(simple), {source:'while (again) { if (stop) break; continue; }',
    labelsRemoved:1,jumpsUnlabeled:2,blocksUnwrapped:0});
  const outer='Outer: while (again) { while (more) { if (stop) break Outer; continue Outer; } }';
  assert.deepEqual(simplifyControlFrames(outer), {source:outer,labelsRemoved:0,jumpsUnlabeled:0,blocksUnwrapped:0});
  const switching='Outer: while (again) { switch (kind) { case 1: if (stop) break Outer; continue Outer; default: break; } }';
  const switched=simplifyControlFrames(switching);
  assert.equal(switched.source,'Outer: while (again) { switch (kind) { case 1: if (stop) break Outer; continue; default: break; } }');
  assert.equal(switched.labelsRemoved,0);assert.equal(switched.jumpsUnlabeled,1);
  const scoped=simplifyControlFrames('Unused: { int value=7; work(value); } work(value);');
  assert.equal(scoped.source,'{ int value=7; work(value); } work(value);');
  assert.equal(scoped.blocksUnwrapped,0);
  assert.equal(simplifyControlFrames('Unused: {\n  {\n    work();\n  }\n}\nfinish();').source,'work();\nfinish();');
  const protectedSource='Loop: while (again) { try { synchronized (lock) { if (stop) break Loop; continue Loop; } } finally { cleanup(); } }';
  assert.equal(simplifyControlFrames(protectedSource).source,'while (again) { try { synchronized (lock) { if (stop) break; continue; } } finally { cleanup(); } }');
  const diagnostic='int Loop=7; Loop: while (again) { print("Loop: break Loop;"); Loop++; break Loop; }';
  assert.equal(simplifyControlFrames(diagnostic).source,'int Loop=7; while (again) { print("Loop: break Loop;"); Loop++; break; }');
  for(const source of [
    'Loop: while (again) { /* retained */ break Loop; }',
    'Loop: while (again) { print("\\u0061"); break Loop; }',
    'Loop: while (again) { break Missing; }',
    'Left: { Loop: while (again) { break Loop; } } Right: { Loop: while (more) { break Loop; } }',
    'Loop: while (again) { class Local { void run() { while (more) { break; } } } break Loop; }',
  ]) {
    const result=simplifyControlFrames(source);
    if(source.startsWith('Left:')) {
      assert.match(result.source,/Loop: while \(again\) \{ break Loop;/);
      assert.match(result.source,/Loop: while \(more\) \{ break Loop;/);
    } else assert.deepEqual(result,{source,labelsRemoved:0,jumpsUnlabeled:0,blocksUnwrapped:0});
  }
});

test('control-frame simplification matches native nested loops, scopes and protected transfers', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-control-frames-'));
  try {
    const finish='finish(x,trace); return done(trace);';
    const variants=[
      `Loop: while (counter < 5) { counter++; if (counter == stop) break Loop; if (flag) continue Loop; before(x,trace); } ${finish}`,
      `Outer: while (counter < 5) { counter++; Inner: for (int index=0;index<3;index++) { trace.append(index); if (counter == stop) break Outer; if (flag) continue Outer; continue Inner; } } ${finish}`,
      `Outer: while (counter < 5) { counter++; switch (counter % 3) { case 0: if (counter == stop) break Outer; if (flag) continue Outer; break; default: before(x,trace); break; } } ${finish}`,
      `Loop: while (counter < 5) { try { synchronized (lock) { trace.append(Thread.holdsLock(lock)?'l':'u'); counter++; if (counter == stop) break Loop; if (flag) continue Loop; before(x,trace); } } finally { trace.append(Thread.holdsLock(lock)?'!':'z'); } } ${finish}`,
      `Loop: while (counter < 5) { counter++; Branch: switch (counter % 3) { case 0: if (flag) break Branch; before(x,trace); break Branch; default: if (counter == stop) break Loop; break Branch; } } ${finish}`,
      `Loop: do { counter++; if (counter == stop) break Loop; if (flag) continue Loop; before(x,trace); } while (counter < 5); ${finish}`,
      `Loop: for (int index=0;index<5;index++) { counter++; if (index == stop) break Loop; if (flag) continue Loop; before(x,trace); } ${finish}`,
      `Loop: for (int entry : new int[]{0,1,2,3,4}) { counter++; if (entry == stop) break Loop; if (flag) continue Loop; before(x,trace); } ${finish}`,
      `Unused: { double value=x; { finish(value,trace); } } trace.append(value); return done(trace);`,
      `Unused: { for (int value=0;value<3;value++) { counter++; trace.append(value); } } trace.append(value); ${finish}`,
      `try { Unused: { { before(x,trace); } } ${finish} } catch (IndexOutOfBoundsException failure) { trace.append('c'); return done(trace); } finally { trace.append('z'); counter++; }`,
      `Exit: { Loop: while (counter < 5) { counter++; if (counter == stop) break Exit; if (flag) continue Loop; before(x,trace); } trace.append('e'); } ${finish}`,
      `Unused: { if (flag) { before(x,trace); return done(trace); } } ${finish}`,
      `if (flag) { Unused: { trace.append('t'); throw sentinel; } } ${finish}`,
      `Loop: while (counter < 5) { counter++; Loop++; trace.append("Loop: continue Loop;"); if (flag) continue Loop; before(x,trace); } ${finish}`,
      `if (flag) Unused: { { before(x,trace); } finish(x,trace); } else Other: { trace.append('a'); } return done(trace);`,
    ];
    const methods=[];
    variants.forEach((original,index)=>{
      let body=original,changes=0;
      for(;;) {
        const next=simplifyControlFrames(body),count=next.labelsRemoved+next.jumpsUnlabeled+next.blocksUnwrapped;
        if(!count)break;
        assert.ok(next.source.length<body.length,'cleanup must remove source, not add routing');
        body=next.source;changes+=count;
      }
      assert.ok(changes>0,original);
      for(const[label,source]of[['original',original],['rebuilt',body]])
        methods.push(`static String ${label}${index}(boolean flag,int stop,double x,Object lock) {
          StringBuilder trace=new StringBuilder(); try { ${source} }
          catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace+":"+(failure == sentinel); }
        }`);
    });
    const source=`public class ControlFrames {
      static int mode,counter,Loop; static double value=3;
      static final IllegalStateException sentinel=new IllegalStateException();
      static void before(double x,StringBuilder trace) { trace.append('b'); if (mode == 1 && x == 7) throw new IndexOutOfBoundsException(); }
      static void finish(double x,StringBuilder trace) { trace.append('f'); if (mode == 2 && Double.isNaN(x)) throw new IllegalArgumentException(); trace.append(Double.doubleToRawLongBits(x)); }
      static String done(StringBuilder trace) { trace.append('d'); if (mode == 3) throw sentinel; return trace.toString(); }
      ${methods.join('\n')}
      public static void main(String[] args) {
        Object lock=new Object();
        for (mode=0;mode<4;mode++) for (boolean flag:new boolean[]{false,true})
          for (int stop:new int[]{0,2,4,7}) for (double x:new double[]{-1,-0d,7,Double.NaN}) {
            ${variants.map((_,index)=>`{
              counter=0; Loop=3; String expected=original${index}(flag,stop,x,lock); int expectedCounter=counter,expectedLoop=Loop;
              counter=0; Loop=3; String actual=rebuilt${index}(flag,stop,x,lock);
              if (!expected.equals(actual) || counter != expectedCounter || Loop != expectedLoop || Thread.holdsLock(lock))
                throw new AssertionError(${index}+":"+mode+":"+flag+":"+stop+":"+x+":"+expected+":"+actual+":"+expectedCounter+":"+counter);
              System.out.println(${index}+":"+mode+":"+flag+":"+stop+":"+x+":"+actual+":"+counter+":"+Loop);
            }`).join('\n')}
          }
      }
    }`;
    const file=path.join(temporary,'ControlFrames.java');fs.writeFileSync(file,source);
    run('javac',['--release','8','-d',temporary,file],temporary);
    assert.equal(run('java',['-cp',temporary,'ControlFrames'],temporary).trim().split('\n').length,2048);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('control-frame corpus preserves Java AST events and resolved transfer destinations', (t) => {
  const before=process.env.CFR_CONTROL_FRAMES_BEFORE,after=process.env.CFR_CONTROL_FRAMES_AFTER;
  if(!before&&!after){t.skip('supply original and regenerated Java corpora for the publication check');return;}
  assert.ok(before&&after,'both corpus directories are required');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-control-frame-corpus-'));
  try {
    const source=`import java.nio.file.*; import java.util.*; import javax.tools.*;
      import com.sun.source.tree.*; import com.sun.source.util.*;
      public class ControlFrameCorpus extends TreeScanner<Void,Void> {
        final StringBuilder events=new StringBuilder();
        final IdentityHashMap<Tree,Integer> targets=new IdentityHashMap<>();
        final ArrayList<Tree> loops=new ArrayList<>(),breakables=new ArrayList<>();
        final ArrayList<LabeledStatementTree> labels=new ArrayList<>();
        int ordinal,jumps;
        static boolean loop(Tree.Kind kind){return kind==Tree.Kind.WHILE_LOOP||kind==Tree.Kind.FOR_LOOP||kind==Tree.Kind.ENHANCED_FOR_LOOP||kind==Tree.Kind.DO_WHILE_LOOP;}
        public Void scan(Tree node,Void ignored) {
          if(node==null)return null;
          Tree.Kind kind=node.getKind();
          if(kind==Tree.Kind.LABELED_STATEMENT)return visitLabeledStatement((LabeledStatementTree)node,ignored);
          if(kind==Tree.Kind.BREAK||kind==Tree.Kind.CONTINUE) {
            String label=kind==Tree.Kind.BREAK?string(((BreakTree)node).getLabel()):string(((ContinueTree)node).getLabel());
            Tree target=null;
            if(label.isEmpty()) {
              ArrayList<Tree> stack=kind==Tree.Kind.CONTINUE?loops:breakables;
              if(!stack.isEmpty())target=stack.get(stack.size()-1);
            } else for(int i=labels.size()-1;i>=0;i--)if(labels.get(i).getLabel().contentEquals(label)){target=labels.get(i).getStatement();break;}
            if(target==null)throw new AssertionError("unbound transfer "+node);
            events.append(kind).append(':');
            if(targets.containsKey(target))events.append(target.getKind()).append('#').append(targets.get(target));
            else {
              String targetLabel="";
              for(int i=labels.size()-1;i>=0;i--)if(labels.get(i).getStatement()==target){targetLabel=labels.get(i).getLabel().toString();break;}
              if(targetLabel.isEmpty())throw new AssertionError("unidentified labeled destination");
              events.append(target.getKind()).append(':').append(targetLabel);
            }
            events.append('\\n');jumps++;return null;
          }
          if(kind!=Tree.Kind.BLOCK) {
            events.append(kind);
            if(node instanceof IdentifierTree)events.append(':').append(((IdentifierTree)node).getName());
            if(node instanceof MemberSelectTree)events.append(':').append(((MemberSelectTree)node).getIdentifier());
            if(node instanceof LiteralTree)events.append(':').append(node.toString());
            if(node instanceof VariableTree)events.append(':').append(((VariableTree)node).getName());
            if(node instanceof MethodTree)events.append(':').append(((MethodTree)node).getName());
            if(node instanceof ClassTree)events.append(':').append(((ClassTree)node).getSimpleName());
            if(node instanceof ModifiersTree)events.append(':').append(((ModifiersTree)node).getFlags());
            events.append('\\n');
          }
          boolean isLoop=loop(kind),breakable=isLoop||kind==Tree.Kind.SWITCH;
          if(breakable){targets.put(node,ordinal++);breakables.add(node);}
          if(isLoop)loops.add(node);
          Void result=super.scan(node,ignored);
          if(isLoop)loops.remove(loops.size()-1);
          if(breakable)breakables.remove(breakables.size()-1);
          return result;
        }
        public Void visitLabeledStatement(LabeledStatementTree node,Void ignored){labels.add(node);scan(node.getStatement(),ignored);labels.remove(labels.size()-1);return null;}
        public Void visitMethod(MethodTree node,Void ignored) {
          ArrayList<Tree> oldLoops=new ArrayList<>(loops),oldBreakables=new ArrayList<>(breakables);
          ArrayList<LabeledStatementTree> oldLabels=new ArrayList<>(labels);
          loops.clear();breakables.clear();labels.clear();
          Void result=super.visitMethod(node,ignored);
          loops.addAll(oldLoops);breakables.addAll(oldBreakables);labels.addAll(oldLabels);return result;
        }
        static String string(Object value){return value==null?"":value.toString();}
        static ControlFrameCorpus read(Path file)throws Exception {
          JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();
          DiagnosticCollector<JavaFileObject> diagnostics=new DiagnosticCollector<>();
          try(StandardJavaFileManager manager=compiler.getStandardFileManager(diagnostics,null,null)) {
            JavacTask task=(JavacTask)compiler.getTask(null,manager,diagnostics,Arrays.asList("--release","8","-proc:none"),null,manager.getJavaFileObjects(file.toFile()));
            ControlFrameCorpus result=new ControlFrameCorpus();for(CompilationUnitTree unit:task.parse())result.scan(unit,null);
            for(Diagnostic<?> diagnostic:diagnostics.getDiagnostics())if(diagnostic.getKind()==Diagnostic.Kind.ERROR)throw new AssertionError(diagnostic);
            return result;
          }
        }
        static ArrayList<String> inventory(Path root)throws Exception {
          ArrayList<String> files=new ArrayList<>();
          try(java.util.stream.Stream<Path> stream=Files.walk(root)){stream.filter(p->p.toString().endsWith(".java")).forEach(p->files.add(root.relativize(p).toString()));}
          Collections.sort(files);return files;
        }
        public static void main(String[] args)throws Exception {
          Path before=Paths.get(args[0]),after=Paths.get(args[1]);ArrayList<String> files=inventory(before);
          if(!files.equals(inventory(after)))throw new AssertionError("corpus inventories differ");
          int jumps=0,loops=0;
          for(String file:files) {
            ControlFrameCorpus expected=read(before.resolve(file)),actual=read(after.resolve(file));
            String left=expected.events.toString(),right=actual.events.toString();
            if(!left.equals(right)) {
              String[] a=left.split("\\n"),b=right.split("\\n");int index=0;while(index<Math.min(a.length,b.length)&&a[index].equals(b[index]))index++;
              throw new AssertionError(file+":"+index+":"+(index<a.length?a[index]:"end")+":"+(index<b.length?b[index]:"end"));
            }
            jumps+=actual.jumps;loops+=actual.ordinal;
          }
          System.out.println("control-frame-corpus:"+files.size()+":"+loops+":"+jumps);
        }
      }`;
    const file=path.join(temporary,'ControlFrameCorpus.java');fs.writeFileSync(file,source);
    // The checker uses this JDK's compiler API; the inspected sources still
    // parse under Java 8 and their separate full compile also uses --release 8.
    run('javac',['-d',temporary,file],temporary);
    // Parsing the full corpus can exceed the small native-fixture timeout.
    const output=path.join(temporary,'corpus-output'),error=path.join(temporary,'corpus-error');
    const fds=[output,error].map(file=>fs.openSync(file,'w'));
    try {
      const result=spawnSync('java',['-Xmx1024m','-cp',temporary,'ControlFrameCorpus',before,after],{
        stdio:['ignore',...fds],timeout:120000,env:{...process.env,JAVA_TOOL_OPTIONS:'-XX:-UsePerfData'}});
      if(result.error)throw result.error;
      assert.equal(result.status,0,fs.readFileSync(error,'utf8'));
      assert.match(fs.readFileSync(output,'utf8'),/^control-frame-corpus:\d+:\d+:\d+\n$/);
      console.log(fs.readFileSync(output,'utf8').trim());
    } finally {fds.forEach(fd=>fs.closeSync(fd));}
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

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


test('labeled boolean decisions require primitive local scope and unchanged predicate order', () => {
  const source='boolean value=false; Exit: { prefix(); if(a){ if(b){value=true;break Exit;} } if(c){value=true;break Exit;} value=false; }';
  const folded=foldLabeledBooleanDecisions(source);
  assert.deepEqual(folded,{source:'boolean value=false; Exit: { prefix(); value = ((a) && (b)) || (c); }',decisions:1,literalStoresRemoved:2});
  assert.deepEqual(foldLabeledBooleanDecisions(folded.source),{source:folded.source,decisions:0,literalStoresRemoved:0});
  const inverse='boolean value=false; Exit: { if(!a){ if(!b){value=false;break Exit;} } value=true; }';
  assert.equal(foldLabeledBooleanDecisions(inverse).source,'boolean value=false; Exit: { value = (a) || (b); }');
  assert.equal(foldLabeledBooleanDecisions('boolean value=false; Exit: { if(d<=0){value=false;break Exit;} value=true; }').source,
    'boolean value=false; Exit: { value = !(d<=0); }');
  for (const source of [
    'Boolean value=false; Exit: { if(a){value=true;break Exit;} value=false; }',
    'int value=0; Exit: { if(a){value=1;break Exit;} value=0; }',
    '{boolean value=false;} Exit: { if(a){value=true;break Exit;} value=false; }',
    'Exit: { if(a){value=true;break Exit;} value=false; } boolean value=false;',
    'boolean value=false; {boolean value=true;} Exit: { if(a){value=true;break Exit;} value=false; }',
    'boolean value=false; Exit: { if(a){value=true;work();break Exit;} value=false; }',
    'boolean value=false; Exit: { if(a){value=true;break Other;} value=false; }',
    'boolean value=false; Exit: { if(a){value=true;return;} value=false; }',
    'boolean value=false; Exit: { if(a){try {value=true;break Exit;}finally{work();}} value=false; }',
    'boolean value=false; Exit: { if(a){synchronized(lock){value=true;break Exit;}} value=false; }',
    'boolean value=false; Exit: { if(a){value=true;break Exit;} value=true; }',
    'boolean value=false; Exit: { if(a){value=other;break Exit;} value=false; }',
    'boolean value=false; Exit: { if(a){value=true;break Exit;}else{work();} value=false; }',
    'boolean value=false; Exit: { if(a){value=true;break Exit;} value=false; } Exit: {work();}',
    'boolean value=false; Exit: { if(a){value=true;break Exit;} /*scope*/ value=false; }',
    'boolean value=false; Exit: { if(a){value=true;break Exit;} value=false; } String text="\\u0061";',
    'boolean value=false; Exit: { if(a){value=true;break Exit;} value=false; } class Nested {}',
    'boolean value=false; Exit: { if(a){this.value=true;break Exit;} this.value=false; }',
    'boolean value=false; Exit: { if(a){value=true;break Exit;} value=false; finish(); }',
  ]) assert.deepEqual(foldLabeledBooleanDecisions(source),{source,decisions:0,literalStoresRemoved:0},source);
  assert.equal(foldLabeledBooleanDecisions('Exit: { boolean value=false; if(a){value=true;break Exit;} value=false; }').decisions,1);
  const prefix='boolean value=false; Exit: { if(skip)break Exit; prefix(); if(a){value=true;break Exit;} value=false; }';
  assert.equal(foldLabeledBooleanDecisions(prefix).source,
    'boolean value=false; Exit: { if(skip)break Exit; prefix(); value = (a); }');
  const diagnostic='boolean value=false; int Exit=7; Exit: { print("Exit: break Exit;"); if(a){value=true;break Exit;} value=false; }';
  assert.match(foldLabeledBooleanDecisions(diagnostic).source,/int Exit=7; Exit: \{ print\("Exit: break Exit;"\); value = \(a\); \}/);
  const excessive='boolean value=false; Exit: { '+Array.from({length:13},()=> 'if(a){value=true;break Exit;}').join(' ')+' value=false; }';
  assert.equal(foldLabeledBooleanDecisions(excessive).decisions,0);
  const longPredicate='boolean value=false; Exit: { if('+Array(130).fill('a').join(' && ')+'){value=true;break Exit;} value=false; }';
  assert.equal(foldLabeledBooleanDecisions(longPredicate).decisions,0);
});

test('labeled boolean decisions match native short circuits, partial writes and protected ownership', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-boolean-decisions-'));
  try {
    const yes='value=true;break Exit;',no='value=false;break Exit;';
    const p=id=>`p(${id},mask,fail,boxed,d)`;
    const decisions=[
      `if(${p(0)}){if(${p(1)}){if(${p(2)}){${yes}}}} value=false;`,
      `if(!${p(0)}){if(!${p(1)}){if(!${p(2)}){${no}}}} value=true;`,
      `if(${p(0)}){${yes}} if(${p(1)}){${yes}} if(${p(2)}){${yes}} value=false;`,
      `if(${p(0)}){if(${p(1)}){${yes}} if(${p(2)}){${yes}}} if(${p(2)}){${yes}} value=false;`,
      `if(${p(0)}){if(${p(1)}){${no}}} if(${p(2)}){${no}} value=true;`,
      `if(value=!value){if(${p(0)}){${yes}}} if(${p(1)} && (value=!value)){${yes}} value=false;`,
      `if(${p(0)}){if(boxed){${yes}}} if(${p(1)}){${yes}} value=false;`,
      `if(d<=0){if(${p(0)}){${no}}} if(d==0){${no}} value=true;`,
      `if(${p(0)}){if(!boxed){${no}}} value=true;`,
      `if(${p(0)}){{if(${p(1)}){${yes}}}} if(${p(2)}){${yes}} value=false;`,
      `if(${p(0)}){if(${p(1)}){if(${p(2)}){${no}}} if(boxed){${no}}} value=true;`,
      `if(${p(0)}){${yes}} if(value && ${p(1)}){${yes}} if(d!=d){${yes}} value=false;`,
    ];
    const methods=[];
    for(const [index,decision]of decisions.entries()) {
      const frame=`Exit: { trace.append("Exit: break Exit;"); Exit++; ${decision} }`;
      const original=`boolean value=initial; try { ${index%2 ? `synchronized(lock){${frame}}` : frame} }
        catch(RuntimeException error){if(error instanceof IllegalArgumentException && error!=failure)throw new AssertionError("identity");trace.append(error.getClass().getSimpleName());}
        finally{trace.append('F').append(value).append(Thread.holdsLock(lock));} return value+":"+calls+":"+Exit+":"+trace;`;
      const folded=foldLabeledBooleanDecisions(original);
      assert.equal(folded.decisions,1,index);
      assert.ok(folded.source.length<original.length,index);
      const rebuilt=simplifyControlFrames(folded.source).source;
      for(const [name,body]of [['original',original],['rebuilt',rebuilt]]) methods.push(
        `static String ${name}${index}(int mask,int fail,Boolean boxed,double d,boolean initial){${body}}`);
    }
    const source=`public class BooleanDecisions {
      static final Object lock=new Object();static final IllegalArgumentException failure=new IllegalArgumentException();
      static final StringBuilder trace=new StringBuilder();static int calls,Exit;
      static boolean p(int id,int mask,int fail,Boolean boxed,double d){trace.append(id).append(Thread.holdsLock(lock));if(++calls==fail)throw failure;return (mask & (1<<id))!=0;}
      static void reset(){calls=0;Exit=7;trace.setLength(0);}
      ${methods.join('\n')}
      public static void main(String[] args)throws Exception {
        int cases=0;Boolean[] boxes={null,Boolean.FALSE,Boolean.TRUE};double[] values={-1,-0.0,7,Double.NaN};
        for(int variant=0;variant<12;variant++)for(int mask=0;mask<8;mask++)for(int fail=0;fail<6;fail++)
          for(Boolean boxed:boxes)for(double d:values)for(boolean initial:new boolean[]{false,true}){
            java.lang.reflect.Method before=BooleanDecisions.class.getDeclaredMethod("original"+variant,int.class,int.class,Boolean.class,double.class,boolean.class);
            java.lang.reflect.Method after=BooleanDecisions.class.getDeclaredMethod("rebuilt"+variant,int.class,int.class,Boolean.class,double.class,boolean.class);
            reset();Object expected=before.invoke(null,mask,fail,boxed,d,initial);if(Thread.holdsLock(lock))throw new AssertionError("before lock");
            reset();Object actual=after.invoke(null,mask,fail,boxed,d,initial);if(Thread.holdsLock(lock))throw new AssertionError("after lock");
            if(!expected.equals(actual))throw new AssertionError(variant+":"+mask+":"+fail+":"+expected+":"+actual);cases++;
          }
        if(cases!=13824)throw new AssertionError(cases);System.out.println("boolean-decision-native:"+cases);
      }
    }`;
    const file=path.join(temporary,'BooleanDecisions.java');fs.writeFileSync(file,source);
    run('javac',['--release','8','-d',temporary,file],temporary);
    assert.equal(run('java',['-cp',temporary,'BooleanDecisions'],temporary).trim(),'boolean-decision-native:13824');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});


test('void exit recovery preserves exact destinations and proves trailing-return reachability', () => {
  const source='Exit: { if(stop)break Exit; work(); } return;';
  const result=foldVoidReturnExits(source);
  assert.deepEqual(result,{source:'Exit: { if(stop)return; work(); } return;',frames:1,jumpsReturned:1,tailsRemoved:0});
  assert.deepEqual(foldVoidReturnExits(result.source),{source:result.source,frames:0,jumpsReturned:0,tailsRemoved:0});
  for(const loop of ['while(true)','for(;;)','do']) {
    const body=loop==='do' ? 'do { if(stop)break Exit; work(); } while(true);' : `${loop} { if(stop)break Exit; work(); }`;
    const folded=foldVoidReturnExits(`Exit: { ${body} } return;`);
    assert.equal(folded.frames,1,loop);assert.equal(folded.tailsRemoved,1,loop);
    assert.equal((folded.source.match(/return;/g)||[]).length,1,loop);
  }
  const localFor=foldVoidReturnExits('Exit: { for(boolean flag=true;flag;flag=false){if(stop)break Exit;} } return;');
  assert.equal(localFor.frames,1);assert.equal(localFor.tailsRemoved,0);
  const constantFor=foldVoidReturnExits('Exit: { for(final boolean flag=true;flag;){if(stop)break Exit;} } return;');
  assert.equal(constantFor.frames,1);assert.equal(constantFor.tailsRemoved,1);
  const constant=foldVoidReturnExits('final boolean forever=true; Exit: { while(forever){if(stop)break Exit;} } return;');
  assert.equal(constant.frames,1);assert.equal(constant.tailsRemoved,1);
  const conditional=foldVoidReturnExits('Exit: { if(stop)break Exit; else return; } return;');
  assert.equal(conditional.tailsRemoved,1);
  const protectedExit=foldVoidReturnExits('Exit: { try { synchronized(lock){if(stop)break Exit;work();} }finally{cleanup();} } return;');
  assert.equal(protectedExit.frames,1);assert.equal(protectedExit.tailsRemoved,0);assert.match(protectedExit.source,/synchronized\(lock\)\{if\(stop\)return;work\(\);\}/);
  const ownBreak=foldVoidReturnExits('Exit: { Loop: while(true){try{if(stop)break Exit;break Loop;}finally{cleanup();}} } return;');
  assert.equal(ownBreak.frames,1);assert.equal(ownBreak.tailsRemoved,0);assert.match(ownBreak.source,/break Loop;/);
  const overriddenBreak=foldVoidReturnExits('Exit: { while(true){try{if(stop)break Exit;break;}finally{if(mode)break Exit;else return;}} } return;');
  assert.equal(overriddenBreak.frames,1);assert.equal(overriddenBreak.tailsRemoved,1);
  const scoped='Exit: { boolean saved=true; if(stop)break Exit; work(saved); } return;';
  assert.match(simplifyControlFrames(foldVoidReturnExits(scoped).source).source,/\{ boolean saved=true;/);
  const diagnostic='int Exit=7; Exit: { print("Exit: break Exit;"); if(stop)break Exit; work(Exit); } return;';
  assert.equal(foldVoidReturnExits(diagnostic).source,'int Exit=7; Exit: { print("Exit: break Exit;"); if(stop)return; work(Exit); } return;');
  for(const source of [
    'Exit: { if(stop)break Exit; work(); } return value;',
    'Exit: { if(stop)break Exit; work(); } return finish();',
    'Exit: { if(stop)break Exit; work(); } work(); return;',
    'Exit: while(true){if(stop)break Exit;} return;',
    'Exit: { if(stop)continue Exit; work(); } return;',
    'Exit: { if(stop)break Missing; work(); } return;',
    'Exit: { if(stop)break Exit; work(); } return; Exit: {finish();}',
    'Exit: { if(stop)break Exit; /*preserve*/ work(); } return;',
    'Exit: { if(stop)break Exit; work(); } return; class Nested {}',
    'Exit: { if(stop)break Exit; work(); } return; String text="\\u0061";',
    'Exit: { while(flag){if(stop)break Exit;} } return;',
    'Exit: { while(flag){if(stop)break Exit;} final boolean flag=true; } return;',
    'boolean owner=false; Exit: { while(owner.CONSTANT){if(stop)break Exit;} } return;',
    'Exit: { switch(value){default:if(stop)break Exit;work();} } return;',
    'Exit: { try(Resource resource=new Resource()){if(stop)break Exit;work();} } return;',
  ])assert.deepEqual(foldVoidReturnExits(source),{source,frames:0,jumpsReturned:0,tailsRemoved:0},source);
});

test('void exit recovery matches native cleanup overriding, failure identity and all loop forms', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-void-return-exits-'));
  try {
    const bodies=[
      'if(mode==0)break Exit;touch(1);',
      'if(mode==0){break Exit;}else{touch(1);return;}',
      'int i=0;while(true){touch(i);if(i++>=stop)break Exit;}',
      'int i=0;for(;;){touch(i);if(i++>=stop)break Exit;}',
      'for(int i=0;i<4;i++){touch(i);if(i==stop)break Exit;}',
      'int i=0;do{touch(i);if(i++>=stop)break Exit;continue;}while(true);',
      'for(int i:new int[]{0,1,2}){touch(i);if(i==stop)break Exit;}',
      'Inner:{if(mode==0)break Inner;touch(1);}if(gate)break Exit;touch(2);',
      'try{touch(0);if(gate)break Exit;touch(1);}finally{touch(2);}',
      'synchronized(lock){touch(0);if(gate)break Exit;touch(1);}',
      'try{synchronized(lock){touch(0);if(gate)break Exit;touch(1);}}catch(IllegalArgumentException error){trace.append(error==failure);touch(3);}finally{touch(2);}',
      'try{touch(0);throw failure;}finally{touch(2);if(gate)break Exit;}',
      'try{try{touch(0);if(gate)break Exit;touch(1);}finally{touch(2);if(cleanupMode==1)throw closeFailure;}}catch(RuntimeException error){trace.append(error==failure?"I":"C");touch(3);}',
      'try{touch(0);if(gate)break Exit;touch(1);}finally{touch(2);if(cleanupMode==2&&j==0)continue;}',
      'Resource resource=new Resource();try{touch(0);if(gate)break Exit;touch(1);}finally{resource.close();}',
      'try{touch(0);if(gate)break Exit;touch(1);}finally{touch(2);if(cleanupMode==2)break Outer;}',
    ];
    const methods=[];
    for(const [index,body]of bodies.entries()) {
      let contents=`trace.append("Exit: break Exit;");Exit++;Exit:{${body}}return;`;
      if(index===13)contents=`for(int j=0;j<2;j++){${contents}}touch(9);`;
      if(index===15)contents=`Outer:for(int j=0;j<2;j++){${contents}}touch(9);`;
      const original=`try{${contents}}finally{touch(11);}`;
      const folded=foldVoidReturnExits(original);
      assert.equal(folded.frames,1,index);assert.ok(folded.jumpsReturned>=1,index);
      assert.deepEqual(foldVoidReturnExits(folded.source),{source:folded.source,frames:0,jumpsReturned:0,tailsRemoved:0},index);
      const rebuilt=simplifyControlFrames(folded.source).source;
      for(const [name,source]of [['original',original],['rebuilt',rebuilt]])methods.push(`static void ${name}${index}(){${source}}`);
    }
    const source=`public class VoidReturnExits {
      static final Object lock=new Object();static final StringBuilder trace=new StringBuilder();
      static final IllegalArgumentException failure=new IllegalArgumentException();static final AssertionError fatal=new AssertionError();
      static final IllegalStateException closeFailure=new IllegalStateException();static int calls,state,Exit,mode,stop,cleanupMode,failureKind,failAt;static boolean gate;
      static void touch(int tag){trace.append(tag).append(':').append(Thread.holdsLock(lock)).append(',');state=state*17+tag;
        if(++calls==failAt){if(failureKind==0)throw failure;if(failureKind==1)throw fatal;throw closeFailure;}}
      static class Resource implements AutoCloseable {Resource(){touch(4);}public void close(){touch(5);if(cleanupMode==3)throw closeFailure;}}
      static String invoke(String method)throws Exception {
        calls=0;state=0;Exit=7;trace.setLength(0);String outcome="ok";
        try{VoidReturnExits.class.getDeclaredMethod(method).invoke(null);}catch(java.lang.reflect.InvocationTargetException wrapper){
          Throwable error=wrapper.getCause();if(error==failure)outcome="failure";else if(error==fatal)outcome="fatal";else if(error==closeFailure)outcome="close";else throw new AssertionError(error);}
        if(Thread.holdsLock(lock))throw new AssertionError("monitor retained");return outcome+":"+calls+":"+state+":"+Exit+":"+trace;
      }
      ${methods.join('\n')}
      public static void main(String[] args)throws Exception {
        int cases=0;
        for(int variant=0;variant<16;variant++)for(mode=0;mode<5;mode++)for(stop=0;stop<4;stop++)for(cleanupMode=0;cleanupMode<4;cleanupMode++)
          for(failureKind=0;failureKind<3;failureKind++)for(failAt=0;failAt<6;failAt++)for(boolean flag:new boolean[]{false,true}){
            gate=flag;String expected=invoke("original"+variant),actual=invoke("rebuilt"+variant);
            if(!expected.equals(actual))throw new AssertionError(variant+":"+mode+":"+stop+":"+cleanupMode+":"+failureKind+":"+failAt+":"+gate+":"+expected+":"+actual);cases++;
          }
        if(cases!=46080)throw new AssertionError(cases);System.out.println("void-return-native:"+cases);
      }
    }`;
    const file=path.join(temporary,'VoidReturnExits.java');fs.writeFileSync(file,source);
    run('javac',['--release','8','-d',temporary,file],temporary);
    assert.equal(run('java',['-cp',temporary,'VoidReturnExits'],temporary).trim(),'void-return-native:46080');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});


test('nested if guards preserve predicate bytes and innermost declaration scopes', () => {
  const source='if(first()){ if(second()){ if(third()){ int local=1; use(local); } } }';
  const result=foldNestedIfGuards(source);
  assert.deepEqual(result,{source:'if ((first()) && (second()) && (third())) { int local=1; use(local); }',guardsFolded:1,conditionsMerged:2});
  assert.deepEqual(foldNestedIfGuards(result.source),{source:result.source,guardsFolded:0,conditionsMerged:0});
  const protectedSource='try { synchronized(lock) { if(a){if(b){try { work(); } finally { clean(); }}} } } catch(RuntimeException error){recover();}';
  assert.equal(foldNestedIfGuards(protectedSource).guardsFolded,1);
  const scope='if(a){ if(b){ int value=1; use(value); } } int value=2; use(value);';
  assert.equal(foldNestedIfGuards(scope).source,'if ((a) && (b)) { int value=1; use(value); } int value=2; use(value);');
  const formatted='if (a) {\n  if (b) {\n    work();\n  }\n}';
  assert.equal(foldNestedIfGuards(formatted).source,'if ((a) &&\n    (b)) {\n  work();\n}');
  for (const source of [
    'if(a){if(b){work();}else{other();}}',
    'if(a){if(b){work();}}else{other();}',
    'if(a){prefix();if(b){work();}}',
    'if(a){int value=1;if(b){use(value);}}',
    'if(a){Scope:{if(b){break Scope;}}}',
    'if(a){try{if(b){work();}}finally{clean();}}',
    'if(a){synchronized(lock){if(b){work();}}}',
    'if(a){/*keep*/if(b){work();}}',
    'if(a){if(b){work();}} //keep',
    'if(a){if(b){work();}} trailing',
    'if(a){if(b){work()}}',
    'if(a){if(b){Runnable r=()->work();}}',
    'if(a){if(b){Object r=new Object(){void run(){work();}};}}',
    'if(a) if(b) work();',
    'if(a){if(b){work();}}\\u000a',
    Array.from({length:17},()=> 'if(a){').join('')+'work();'+'}'.repeat(17),
    'if('+Array(520).fill('a').join('&&')+'){if(b){work();}}',
  ]) assert.deepEqual(foldNestedIfGuards(source),{source,guardsFolded:0,conditionsMerged:0},source);
});

test('nested if guards match native short circuits, unboxing, scopes and cleanup ownership', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-nested-guards-native-'));
  try {
    const p=id=>`p(${id},mask,fail)`;
    const chains=[
      `if(${p(0)}){if(${p(1)}){if(${p(2)}){value++;trace.append('B');}}}`,
      `if(boxed){if(${p(0)}){if(d!=d){value++;}}}`,
      `if(!${p(0)}){if(d<=0){if(!boxed){value+=3;}}}`,
      `if(${p(0)}){if(${p(1)} || ${p(2)}){int local=value+7;value=local;}} int local=13;value+=local;`,
      `if(${p(0)}){if(${p(1)}){throw failure;}}`,
      `if(${p(0)}){if(${p(1)}){return "early:"+value+":"+trace;}}`,
      `if(${p(0)}){if(${p(1)}){try{value=24/(mask-2);}finally{trace.append('I').append(Thread.holdsLock(lock));}}}`,
      `if((value+=3)>0){if(${p(0)}){if((value+=5)>2){trace.append('V').append(value);}}}`,
      `if(true){if(true){final int local=5;value=local;}}`,
      `if(${p(0)}){if(${p(1)}){if(boxed){trace.append('b');}else{trace.append('n');}}}`,
      `if(${p(0)}){if(${p(1)}){synchronized(lock){trace.append('L').append(Thread.holdsLock(lock));value++;}}}`,
      `if(${p(0)}){if(${p(1)}){for(int i=0;i<3;i++){if(i==1)continue;value+=i;}}}`,
    ];
    const methods=[];
    for(const [index,chain]of chains.entries()) {
      const original=`int value=initial;try { ${index%2?`synchronized(lock){${chain}}`:chain} }
        catch(RuntimeException error){if(error instanceof IllegalArgumentException && error!=failure)throw new AssertionError("identity");trace.append(error.getClass().getSimpleName()).append(value).append(Thread.holdsLock(lock));}
        finally{trace.append('F').append(value).append(Thread.holdsLock(lock));} return value+":"+calls+":"+trace;`;
      const result=foldNestedIfGuards(original);assert.equal(result.guardsFolded,1,index);
      for(const [name,body]of [['original',original],['rebuilt',result.source]]) methods.push(`static String ${name}${index}(int mask,int fail,Boolean boxed,double d,int initial){${body}}`);
    }
    const source=`public class NestedGuards {
      static final Object lock=new Object();static final IllegalArgumentException failure=new IllegalArgumentException();
      static final StringBuilder trace=new StringBuilder();static int calls;
      static boolean p(int id,int mask,int fail){trace.append(id).append(Thread.holdsLock(lock));if(++calls==fail)throw failure;return (mask&(1<<id))!=0;}
      static void reset(){calls=0;trace.setLength(0);}
      ${methods.join('\n')}
      public static void main(String[] args)throws Exception {
        int cases=0;for(int variant=0;variant<12;variant++)for(int mask=0;mask<8;mask++)for(int fail=0;fail<5;fail++)
        for(Boolean boxed:new Boolean[]{null,Boolean.FALSE,Boolean.TRUE})for(double d:new double[]{-1,-0.0,7,Double.NaN})for(int initial:new int[]{-7,0,9}){
          java.lang.reflect.Method before=NestedGuards.class.getDeclaredMethod("original"+variant,int.class,int.class,Boolean.class,double.class,int.class);
          java.lang.reflect.Method after=NestedGuards.class.getDeclaredMethod("rebuilt"+variant,int.class,int.class,Boolean.class,double.class,int.class);
          reset();Object expected=before.invoke(null,mask,fail,boxed,d,initial)+":"+calls+":"+trace;if(Thread.holdsLock(lock))throw new AssertionError("before lock");
          reset();Object actual=after.invoke(null,mask,fail,boxed,d,initial)+":"+calls+":"+trace;if(Thread.holdsLock(lock))throw new AssertionError("after lock");
          if(!expected.equals(actual))throw new AssertionError(variant+":"+mask+":"+fail+":"+expected+":"+actual);cases++;
        }
        if(cases!=17280)throw new AssertionError(cases);System.out.println("nested-guard-native:"+cases);
      }
    }`;
    const file=path.join(temporary,'NestedGuards.java');fs.writeFileSync(file,source);
    run('javac',['--release','8','-d',temporary,file],temporary);
    assert.equal(run('java',['-cp',temporary,'NestedGuards'],temporary).trim(),'nested-guard-native:17280');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});


test('leading labeled skip guards retain predicate bytes, remainder scope and refuse other exits',()=>{
  const source='Exit: { if (first()) { break Exit; } if (second()) { break Exit; } int value=next(); use(value); }';
  const result=foldLabeledSkipGuards(source);
  assert.deepEqual(result,{source:'if (!(first()) && !(second())) { int value=next(); use(value); }',framesRemoved:1,guardJumpsRemoved:2});
  assert.deepEqual(foldLabeledSkipGuards(result.source),{source:result.source,framesRemoved:0,guardJumpsRemoved:0});
  const formatted='  Exit: {\n    if (left()) {\n      break Exit;\n    }\n    if (right()) {\n      break Exit;\n    }\n    int value = 7;\n    use(value);\n  }';
  assert.equal(foldLabeledSkipGuards(formatted).source,'  if (!(left()) &&\n      !(right())) {\n    int value = 7;\n    use(value);\n  }');
  assert.equal(foldLabeledSkipGuards('try { Exit: { if (pick()) { break Exit; } work(); } } finally { cleanup(); }').framesRemoved,1);
  assert.equal(foldLabeledSkipGuards('Exit: { if (pick()) { break Exit; } synchronized(lock) { work(); } }').framesRemoved,1);
  assert.equal(foldLabeledSkipGuards('Loop: while(again()) { Exit: { if (pick()) { break Exit; } continue Loop; } tail(); }').framesRemoved,1);
  const guards=count=>Array.from({length:count},(_,i)=>'if (pick'+i+'()) { break Exit; }').join(' ');
  for(const source of [
    'Exit: { if (pick()) { break Exit; } }',
    'Exit: { before(); if (pick()) { break Exit; } work(); }',
    'Exit: { if (pick()) { before(); break Exit; } work(); }',
    'Exit: { if (pick()) { break Exit; } else { other(); } work(); }',
    'Exit: { if (pick()) break Exit; work(); }',
    'Exit: { if (pick()) { break Other; } work(); }',
    'Exit: { if (pick()) { break Exit; } work(); } break Missing;',
    'Exit: { if (pick()) { break Exit; } if (other()) { break Exit; } else { work(); } }',
    'Exit: { if (pick()) { break Exit; } try { if(other()) break Exit; work(); } finally { cleanup(); } }',
    'Exit: { try { if(pick()) { break Exit; } } finally { cleanup(); } work(); }',
    'Exit: while(true) { if(pick()) { break Exit; } work(); }',
    'Exit: { if(pick()) { break Exit; } work(); } Exit: { use(); }',
    'Exit: { if(pick()) { break Exit; } class Inner {} work(); }',
    'Exit: { if(pick()) { break Exit; } Runnable run=()->work(); }',
    'Exit: { if(pick()) { break Exit; } // keep\n work(); }',
    'Exit: { if(pick()) { break Exit; } /* keep */ work(); }',
    'Exit: { if(pick()) { break Exit; } raw; }',
    'Exit: { if(pick()) { break Exit; } work() }',
    'Exit: { if(pick()) { break Exit; } work(); } }',
    'Exit: { if(pick()) { break Exit; } \\u0061(); }',
    'Exit: { '+guards(17)+' work(); }',
    'Exit: { if ('+'pick() && '.repeat(130)+'last()) { break Exit; } work(); }',
  ])assert.deepEqual(foldLabeledSkipGuards(source),{source,framesRemoved:0,guardJumpsRemoved:0},source);
});

test('labeled skip guards match native short circuits, scopes, ancestor transfers and cleanup',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-skip-guards-native-'));
  try {
    const variants=[
      'Exit: { if (pick(0,boxed)) { break Exit; } work(); } tail();',
      'Exit: { if (pick(0,boxed)) { break Exit; } if (pick(1,boxed)) { break Exit; } work(); } tail();',
      'Exit: { if (floating < 0d) { break Exit; } if (pick(0,boxed)) { break Exit; } work(); } tail();',
      'Exit: { if (pick(0,boxed)) { break Exit; } int local=++value; trace.append(local); work(); } { int local=7; trace.append(local); } tail();',
      'try { Exit: { if (pick(0,boxed)) { break Exit; } work(); } tail(); } finally { cleanup(); }',
      'synchronized(lock) { Exit: { if (pick(0,boxed)) { break Exit; } work(); } trace.append(Thread.holdsLock(lock)); } tail();',
      'Exit: { if (pick(0,boxed)) { break Exit; } try { work(); } catch(IllegalArgumentException error) { trace.append(error==specific); } finally { cleanup(); } } tail();',
      'Outer: for(int index=0;index<3;index++) { Exit: { if(pick(0,boxed)) { break Exit; } work(); if(value<2) continue Outer; if(value>3) break Outer; } tail(); }',
      'switch(mode%3) { case 0: Exit: { if(pick(0,boxed)) { break Exit; } work(); break; } tail(); break; default: work(); } tail();',
      'Exit: { if(pick(0,boxed)) { break Exit; } work(); return value; } tail(); return -1;',
      'Exit: { if(pick(0,boxed)) { break Exit; } synchronized(lock) { work(); } } tail();',
      'Exit: { if(pick(0,boxed)) { break Exit; } while(value<3) { work(); if(value>1) break; } } tail();',
    ];
    const methods=[];
    variants.forEach((original,index)=>{
      const folded=foldLabeledSkipGuards(original);assert.equal(folded.framesRemoved,1,index);
      for(const [name,body] of [['original',original],['rebuilt',folded.source]])
        methods.push('static int '+name+index+'(Boolean boxed,double floating) { '+body+(index===9?'':' return value;')+' }');
    });
    const source=`public class SkipGuards {
      static int mode,value,seen;static Object lock;static StringBuilder trace;
      static final RuntimeException specific=new IllegalArgumentException(),general=new IllegalStateException();
      static final Error fatal=new AssertionError();
      static boolean pick(int index,Boolean boxed) { trace.append('p').append(index);if(mode==1&&index==0)throw specific;if(mode==2&&index==1)throw general;return index==0?boxed:mode%2==0; }
      static void work() {trace.append('w').append(lock!=null&&Thread.holdsLock(lock));value++;if(mode==3)throw general;if(mode==4)throw fatal;}
      static void cleanup() {trace.append('f');seen=value;if(mode==5)throw general;if(mode==6)throw fatal;}
      static void tail() {trace.append('t');value+=2;}
      ${methods.join('\n')}
      interface Call {int call();}
      static String invoke(Call call,boolean nullLock) {
        lock=nullLock?null:new Object();trace=new StringBuilder();value=0;seen=-1;String result;
        try {result="ok:"+call.call();}catch(Throwable error){result=error==specific?"specific":error==general?"general":error==fatal?"fatal":error.getClass().getName();}
        if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor retained");
        return result+":"+value+":"+seen+":"+trace;
      }
      public static void main(String[]args) {
        int cases=0;
        for(mode=0;mode<8;mode++)for(Boolean boxed:new Boolean[]{null,false,true})
        for(double floating:new double[]{Double.NEGATIVE_INFINITY,-1,-0d,0d,1,Double.POSITIVE_INFINITY,Double.NaN})
        for(boolean nullLock:new boolean[]{false,true}) {
          ${variants.map((_,index)=>`{String expected=invoke(()->original${index}(boxed,floating),nullLock),actual=invoke(()->rebuilt${index}(boxed,floating),nullLock);
            if(!expected.equals(actual))throw new AssertionError(${index}+":"+mode+":"+boxed+":"+floating+":"+nullLock+":"+expected+" != "+actual);cases++;}`).join('\n')}
        }
        if(cases!=4032)throw new AssertionError(cases);System.out.println("skip-guard-native:"+cases);
      }
    }`;
    const javaFile=path.join(temporary,'SkipGuards.java');fs.writeFileSync(javaFile,source);
    run('javac',['--release','8','-d',temporary,javaFile],temporary);
    assert.equal(run('java',['-cp',temporary,'SkipGuards'],temporary).trim(),'skip-guard-native:4032');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('fallthrough label breaks remove only proven terminal paths and preserve bare branches',()=>{
  const plain='Exit: { if (pick()) { work(); break Exit; } } tail();';
  assert.deepEqual(removeFallthroughLabelBreaks(plain),{source:'Exit: { if (pick()) { work();  } } tail();',breaksRemoved:1});
  assert.deepEqual(removeFallthroughLabelBreaks('Exit: { if(pick()) break Exit; else break Exit; }'),
    {source:'Exit: { if(pick()) ; else ; }',breaksRemoved:2});
  const multiline='Exit: {\n  work();\n  break Exit;\n}\ntail();';
  assert.equal(removeFallthroughLabelBreaks(multiline).source,'Exit: {\n  work();\n}\ntail();');
  const partial='Exit: { if(pick()) { break Exit; } work(); break Exit; }';
  const removed=removeFallthroughLabelBreaks(partial);assert.equal(removed.breaksRemoved,1);
  assert.match(simplifyControlFrames(removed.source).source,/Exit:/);
  assert.equal(removeFallthroughLabelBreaks('Exit: { Inner: { work(); break Exit; } }').breaksRemoved,1);
  for(const source of [
    'Exit: { if(pick()) { break Exit; } work(); }',
    'Exit: { if(pick()) { break Exit; work(); } }',
    'Exit: { while(pick()) { break Exit; } }',
    'Exit: { for(int i=0;i<3;i++) { break Exit; } }',
    'Exit: { do { break Exit; } while(pick()); }',
    'Exit: { switch(value) { case 0: break Exit; } }',
    'Exit: { try { break Exit; } finally { work(); } }',
    'Exit: { try { break Exit; } catch(RuntimeException error) { work(); } }',
    'Exit: { synchronized(lock) { break Exit; } }',
    'Exit: while(pick()) { break Exit; }',
    'Exit: { continue Exit; }',
    'Exit: { continue; break Exit; }',
    'Exit: { break Other; break Exit; }',
    'Exit: { break Exit; } Exit: { break Exit; }',
    'Exit: { class Local { void run() { work(); } } break Exit; }',
    'Exit: { Runnable r=()->work(); break Exit; }',
    'Exit: { /*keep*/ break Exit; }',
    'Exit: { \\u0061(); break Exit; }',
    'Exit: { raw; break Exit; }',
    'Exit: { work() break Exit; }',
    'Exit: { break Exit; } }',
  ])assert.deepEqual(removeFallthroughLabelBreaks(source),{source,breaksRemoved:0},source);
});

test('fallthrough label breaks match native scopes, effects, ancestor transfers and enclosing cleanup',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-fallthrough-break-native-'));
  try {
    const variants=[
      'Exit: { work(); break Exit; } tail();',
      'Exit: { if(pick(0,boxed)) { work(); break Exit; } } tail();',
      'Exit: { if(floating<0d) { if(pick(0,boxed)) { work(); break Exit; } } } tail();',
      'Exit: { if(pick(0,boxed)) { break Exit; } work(); break Exit; } tail();',
      'try { Exit: { work(); if(pick(0,boxed)) { break Exit; } } tail(); } finally { cleanup(); }',
      'synchronized(lock) { Exit: { work(); if(pick(0,boxed)) { break Exit; } } trace.append(Thread.holdsLock(lock)); } tail();',
      'Exit: { try { work(); } finally { cleanup(); } if(pick(0,boxed)) { break Exit; } } tail();',
      'Exit: { for(int index=0;index<3;index++) { work(); } break Exit; } tail();',
      'Outer: for(int index=0;index<3;index++) { Exit: { work(); if(pick(0,boxed)) continue Outer; break Exit; } tail(); }',
      'switch(mode%3) { case 0: Exit: { work(); break Exit; } tail(); break; default: work(); } tail();',
      'Exit: { if(pick(0,boxed)) break Exit; else break Exit; } tail();',
      'Exit: { { int local=++value; trace.append(local); if(pick(0,boxed)) { break Exit; } } } { int local=7; trace.append(local); } tail();',
      'Exit: { Inner: { work(); break Exit; } } tail();',
      'try { Exit: { work(); break Exit; } } catch(IllegalArgumentException error) { trace.append(error==specific); } tail();',
      'Exit: { if(pick(0,boxed)) { work(); break Exit; } else { throw general; } } tail();',
      'while(value<3) { Exit: { work(); break Exit; } if(mode==7) continue; tail(); } tail();',
    ];
    const methods=[];
    variants.forEach((original,index)=>{
      const removed=removeFallthroughLabelBreaks(original);assert.ok(removed.breaksRemoved>0,index);
      let rebuilt=removed.source;
      for(;;){const next=simplifyControlFrames(rebuilt);if(!next.labelsRemoved&&!next.jumpsUnlabeled&&!next.blocksUnwrapped)break;rebuilt=next.source;}
      for(const [name,body]of[['original',original],['rebuilt',rebuilt]])
        methods.push('static int '+name+index+'(Boolean boxed,double floating) { '+body+' return value; }');
    });
    const source=`public class FallthroughBreaks {
      static int mode,value,seen;static Object lock;static StringBuilder trace;
      static final RuntimeException specific=new IllegalArgumentException(),general=new IllegalStateException();
      static final Error fatal=new AssertionError();
      static boolean pick(int index,Boolean boxed){trace.append('p').append(index);if(mode==1)throw specific;if(mode==2)throw general;return boxed;}
      static void work(){trace.append('w').append(lock!=null&&Thread.holdsLock(lock));value++;if(mode==3)throw general;if(mode==4)throw fatal;}
      static void cleanup(){trace.append('f');seen=value;if(mode==5)throw general;if(mode==6)throw fatal;}
      static void tail(){trace.append('t');value+=2;}
      ${methods.join('\n')}
      interface Call {int call();}
      static String invoke(Call call,boolean nullLock){
        lock=nullLock?null:new Object();trace=new StringBuilder();value=0;seen=-1;String result;
        try{result="ok:"+call.call();}catch(Throwable error){result=error==specific?"specific":error==general?"general":error==fatal?"fatal":error.getClass().getName();}
        if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor retained");
        return result+":"+value+":"+seen+":"+trace;
      }
      public static void main(String[]args){int cases=0;
        for(mode=0;mode<8;mode++)for(Boolean boxed:new Boolean[]{null,false,true})
        for(double floating:new double[]{Double.NEGATIVE_INFINITY,-1,-0d,0d,1,Double.POSITIVE_INFINITY,Double.NaN})
        for(boolean nullLock:new boolean[]{false,true}){
          ${variants.map((_,index)=>`{String expected=invoke(()->original${index}(boxed,floating),nullLock),actual=invoke(()->rebuilt${index}(boxed,floating),nullLock);
            if(!expected.equals(actual))throw new AssertionError(${index}+":"+mode+":"+boxed+":"+floating+":"+nullLock+":"+expected+" != "+actual);cases++;}`).join('\n')}
        }
        if(cases!=5376)throw new AssertionError(cases);System.out.println("fallthrough-break-native:"+cases);
      }
    }`;
    const javaFile=path.join(temporary,'FallthroughBreaks.java');fs.writeFileSync(javaFile,source);
    run('javac',['--release','8','-d',temporary,javaFile],temporary);
    assert.equal(run('java',['-cp',temporary,'FallthroughBreaks'],temporary).trim(),'fallthrough-break-native:5376');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('labeled conditional exits recover alternatives without crossing destination boundaries',()=>{
  const plain='Exit: { first(); if(pick()) { work(); break Exit; } tail(); } after();';
  assert.deepEqual(foldLabeledIfElseExits(plain),{source:'{ first(); if(pick()) { work(); } else { tail(); }} after();',framesRemoved:1,jumpsRemoved:1,guardsRecovered:0});
  const skip=foldLabeledIfElseExits('Exit: { first(); if(pick()) { break Exit; } tail(); }');
  assert.equal(skip.guardsRecovered,1);assert.match(skip.source,/first\(\); if \(!\(pick\(\)\)\)/);
  const scope='Exit: {\n  int local=1;\n  if(pick()) {\n    work();\n    break Exit;\n  }\n  tail();\n}';
  assert.equal(foldLabeledIfElseExits(scope).source,'{\n  int local=1;\n  if(pick()) {\n    work();\n  } else {\n    tail();\n  }\n}');
  assert.match(simplifyControlFrames(foldLabeledIfElseExits(scope).source).source,/^\{/);
  for(const source of [
    'Exit: { if(pick()) { work(); break Exit; } }',
    'Exit: { if(pick()) { work(); break Exit; } else { other(); } tail(); }',
    'Exit: { if(pick()) { if(other()) { break Exit; } } tail(); }',
    'Exit: { if(pick()) { work(); break Exit; other(); } tail(); }',
    'Exit: { if(pick()) { work(); break Exit; } if(other()) { break Exit; } tail(); }',
    'Exit: { if(pick()) { try { break Exit; } finally { work(); } } tail(); }',
    'Exit: { if(pick()) { synchronized(lock) { break Exit; } } tail(); }',
    'Exit: { if(pick()) { while(other()) { break Exit; } } tail(); }',
    'Exit: { if(pick()) break Exit; tail(); }',
    'Exit: while(pick()) { if(other()) { break Exit; } tail(); }',
    'Exit: { if(pick()) { continue Exit; } tail(); }',
    'Exit: { continue; if(pick()) { break Exit; } tail(); }',
    'Exit: { break Other; if(pick()) { break Exit; } tail(); }',
    'Exit: { if(pick()) { break Exit; } tail(); } Exit: { work(); }',
    'Exit: { class Local { void run() {} } if(pick()) { break Exit; } tail(); }',
    'Exit: { Runnable r=()->work(); if(pick()) { break Exit; } tail(); }',
    'Exit: { /*keep*/ if(pick()) { break Exit; } tail(); }',
    'Exit: { \\u0061(); if(pick()) { break Exit; } tail(); }',
    'Exit: { raw; if(pick()) { break Exit; } tail(); }',
    'Exit: { if(pick()) { break Exit; } tail() }',
    'Exit: { if(pick()) { break Exit; } tail(); } }',
  ])assert.deepEqual(foldLabeledIfElseExits(source),{source,framesRemoved:0,jumpsRemoved:0,guardsRecovered:0},source);
});

test('labeled if/else exits match native branch selection, scopes, transfers and protected effects',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-if-else-exit-native-'));
  try {
    const variants=[
      'Exit: { if(pick(boxed)) { work(); break Exit; } tail(); }',
      'Exit: { work(); if(pick(boxed)) { work(); break Exit; } tail(); }',
      'Exit: { int local=++value; if(pick(boxed)) { trace.append(local); break Exit; } trace.append(local); tail(); }',
      'Exit: { work(); if(floating<0d) { work(); break Exit; } tail(); }',
      'Exit: { if(pick(boxed)) { break Exit; } tail(); }',
      'Exit: { int local=++value; if(pick(boxed)) { break Exit; } trace.append(local); tail(); }',
      'try { Exit: { if(pick(boxed)) { work(); break Exit; } tail(); } } finally { cleanup(); }',
      'synchronized(lock) { Exit: { if(pick(boxed)) { work(); break Exit; } tail(); } trace.append(Thread.holdsLock(lock)); }',
      'Exit: { if(pick(boxed)) { try { work(); } finally { cleanup(); } break Exit; } tail(); }',
      'Exit: { if(pick(boxed)) { work(); break Exit; } try { tail(); } finally { cleanup(); } }',
      'Exit: { try { work(); } finally { cleanup(); } if(pick(boxed)) { work(); break Exit; } tail(); }',
      'Outer: for(int index=0;index<3;index++) { Exit: { if(pick(boxed)) { if(mode==7) continue Outer; work(); break Exit; } tail(); } }',
      'switch(mode%3) { case 0: Exit: { if(pick(boxed)) { work(); break Exit; } tail(); } break; default: work(); }',
      'Exit: { if(pick(boxed)) { if(mode==7) return value; work(); break Exit; } tail(); }',
      'Outer: { Exit: { if(pick(boxed)) { if(mode==7) break Outer; work(); break Exit; } if(mode==7) break Outer; tail(); } work(); }',
      'Exit: { if(pick(boxed)) { work(); break Exit; } for(int index=0;index<3;index++) { tail(); } }',
      'Exit: { Inner: { work(); if(mode==7) break Inner; tail(); } if(pick(boxed)) { work(); break Exit; } tail(); }',
      'Exit: { if(pick(boxed)) { int local=++value; trace.append(local); break Exit; } int local=7; trace.append(local); tail(); }',
      'try { Exit: { if(pick(boxed)) { work(); break Exit; } tail(); } } catch(IllegalArgumentException error) { trace.append(error==specific); }',
      'int index=0; do { Exit: { int local=++value; if(pick(boxed)) { trace.append(local); break Exit; } tail(); } { int local=7; trace.append(local); } } while(++index<2);',
    ];
    const methods=[];
    variants.forEach((original,index)=>{
      let rebuilt=original,frames=0;
      for(;;){const next=foldLabeledIfElseExits(rebuilt);if(!next.framesRemoved)break;rebuilt=next.source;frames+=next.framesRemoved;
        for(;;){const cleaned=simplifyControlFrames(rebuilt);if(!cleaned.labelsRemoved&&!cleaned.jumpsUnlabeled&&!cleaned.blocksUnwrapped)break;rebuilt=cleaned.source;}
      }
      assert.ok(frames>0,index);
      for(const [name,body]of[['original',original],['rebuilt',rebuilt]])methods.push('static int '+name+index+'(Boolean boxed,double floating) { '+body+' return value; }');
    });
    const source=`public class IfElseExits {
      static int mode,value,seen;static Object lock;static StringBuilder trace;
      static final RuntimeException specific=new IllegalArgumentException(),general=new IllegalStateException();
      static final Error fatal=new AssertionError();
      static boolean pick(Boolean boxed){trace.append('p');if(mode==1)throw specific;if(mode==2)throw general;return boxed;}
      static void work(){trace.append('w').append(lock!=null&&Thread.holdsLock(lock));value++;if(mode==3)throw general;if(mode==4)throw fatal;}
      static void cleanup(){trace.append('f');seen=value;if(mode==5)throw general;if(mode==6)throw fatal;}
      static void tail(){trace.append('t');value+=2;}
      ${methods.join('\n')}
      interface Call {int call();}
      static String invoke(Call call,boolean nullLock){
        lock=nullLock?null:new Object();trace=new StringBuilder();value=0;seen=-1;String result;
        try{result="ok:"+call.call();}catch(Throwable error){result=error==specific?"specific":error==general?"general":error==fatal?"fatal":error.getClass().getName();}
        if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor retained");
        return result+":"+value+":"+seen+":"+trace;
      }
      public static void main(String[]args){int cases=0;
        if(!invoke(()->rebuilt0(true,0),false).equals("ok:1:1:-1:pwfalse"))throw new AssertionError("selected branch oracle");
        if(!invoke(()->rebuilt0(false,0),false).equals("ok:2:2:-1:pt"))throw new AssertionError("fallback oracle");
        for(mode=0;mode<8;mode++)for(Boolean boxed:new Boolean[]{null,false,true})
        for(double floating:new double[]{Double.NEGATIVE_INFINITY,-1,-0d,0d,1,Double.POSITIVE_INFINITY,Double.NaN})
        for(boolean nullLock:new boolean[]{false,true}){
          ${variants.map((_,index)=>`{String expected=invoke(()->original${index}(boxed,floating),nullLock),actual=invoke(()->rebuilt${index}(boxed,floating),nullLock);
            if(!expected.equals(actual))throw new AssertionError(${index}+":"+mode+":"+boxed+":"+floating+":"+nullLock+":"+expected+" != "+actual);cases++;}`).join('\n')}
        }
        if(cases!=6720)throw new AssertionError(cases);System.out.println("if-else-exit-native:"+cases);
      }
    }`;
    const javaFile=path.join(temporary,'IfElseExits.java');fs.writeFileSync(javaFile,source);
    run('javac',['--release','8','-d',temporary,javaFile],temporary);
    assert.equal(run('java',['-cp',temporary,'IfElseExits'],temporary).trim(),'if-else-exit-native:6720');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
