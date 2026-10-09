'use strict';
const test = require('node:test');
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const {spawnSync} = require('child_process');
const {recoverPostGuardExits: recover, specializePathGuards, simplifyControlFrames}
  = require('../src/decompiler/javaAstEmitter');

function guards(source) {
  for (;;) {
    const next = specializePathGuards(source);
    if (!next.guardsSpecialized) break;
    source = next.source;
  }
  for (;;) {
    const next = simplifyControlFrames(source);
    if (next.source === source) return source;
    source = next.source;
  }
}

test('final exit recovery consumes newly exposed frames and reaches a fixed point', () => {
  const source = 'int guard=mode;Exit:{if(guard!=0){if(guard!=0){step("A");break Exit;}}step("B");}step("tail");';
  const prepared = guards(source);
  assert.notEqual(prepared, source);
  const next = recover(prepared, {parameterNames: ['mode']});
  assert.ok(next.rewrites > 0);
  assert.ok(!next.source.includes('break Exit'));
  assert.equal(recover(next.source, {parameterNames: ['mode']}).rewrites, 0);
  assert.equal(recover(next.source, {parameterNames: ['mode']}).source, next.source);
  assert.ok(!Object.hasOwn(next, 'diagnostics'));
  const loops = recover('int index=0;Exit:{while(true){if(index==2)break Exit;index++;}}step("tail");');
  assert.ok(loops.counts.localizedLoopBreaks > 0);
  assert.ok(loops.counts.leadingLoopGuards > 0);
  assert.ok(!loops.source.includes('break Exit'));
});

test('post-guard recovery propagates no value facts and respects protected destinations', () => {
  const source = 'int guard=Holder.flag;Exit:{if(guard!=0){step("A");break Exit;}if(guard==0){step("B");}}step("tail");';
  const next = recover(source);
  assert.ok(next.rewrites > 0);
  assert.match(next.source, /guard!=0/);
  assert.match(next.source, /guard==0/);
  const protectedExit = 'Exit:{try{if(predicate())break Exit;step("A");}finally{cleanup();}step("B");}step("tail");';
  assert.equal(recover(protectedExit).rewrites, 0);
  assert.equal(recover(protectedExit).source, protectedExit);
});

test('incomplete syntax, namespaces, nested executables and invalid formal names refuse recovery', () => {
  for (const source of [
    'Exit:{if(predicate()){step("A");break Missing;}step("B");}',
    'Exit:{if(predicate()){step("A");continue Exit;}step("B");}',
    'Exit:{Exit:{if(predicate())break Exit;}step("B");}',
    'Exit:{if(predicate()){step("A") break Exit;}step("B");}',
    'Exit:{if(predicate()){1+2;break Exit;}step("B");}',
    'Exit:{if(predicate()){step("A");break Exit;}step("B");} /* comment */',
    'Exit:{if(predicate()){step("A");break Exit;}step("B");}\\u000a',
    'Runnable r=()->{};Exit:{if(predicate()){step("A");break Exit;}step("B");}',
    'class Nested{} Exit:{if(predicate()){step("A");break Exit;}step("B");}',
  ]) {
    const next = recover(source);
    assert.equal(next.rewrites, 0, source);
    assert.equal(next.source, source);
  }
  const source = 'Exit:{if(predicate()){step("A");break Exit;}step("B");}';
  for (const parameterNames of [null, ['mode', 'mode'], ['mode.bad'], [1]])
    assert.equal(recover(source, {parameterNames}).source, source);
});

test('composed guard/exit recovery preserves native ordering, mutations, NaNs, cleanup and transfers', () => {
  const variants = [
    'Exit:{if(predicate()){step("A");break Exit;}step("B");}step("tail");',
    'int guard=mode;Exit:{if(guard!=0){if(guard!=0){step("A");break Exit;}}step("B");}step("tail");',
    'int guard=mode;Exit:{if(guard!=0)break Exit;step("A");if(guard==0)break Exit;step("bad");}step("tail");',
    'Exit:{if(predicate()){if(other()){step("A");break Exit;}else{step("B");break Exit;}}step("C");}step("tail");',
    'Outer:{Inner:{if(predicate()){step("A");break Inner;}step("B");}if(other()){step("C");break Outer;}step("D");}step("tail");',
    'Exit:{if(predicate()){try{step("A");}finally{cleanup();}break Exit;}step("B");}step("tail");',
    'synchronized(lock){Exit:{if(predicate()){step("A");break Exit;}step("B");}}step("tail");',
    'Exit:{if(predicate()){for(int index=0;index<2;index++){step("A"+index);}break Exit;}step("B");}step("tail");',
    'int index=0;Exit:{while(true){if(index==2)break Exit;step("A");index++;}}step("tail");',
    'int index=0;while(true){if(!(metric<0))break;step("A");if(++index>=2)break;}step("tail");',
    'Exit:{if(predicate()){step("A");break Exit;}step("B");}return;',
    'int guard=mode;Exit:{if(guard==0){guard=input;if(guard==0){step("A");break Exit;}}step("B");}step("tail");',
    'try{Exit:{if(predicate()){step("A");break Exit;}step("B");}}finally{cleanup();}step("tail");',
    'Exit:{try{if(predicate())break Exit;step("A");}finally{cleanup();}step("B");}step("tail");',
  ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'post-guard-exits-native-'));
  function run(command, args) {
    const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
    const descriptors = files.map(file => fs.openSync(file, 'w'));
    try {
      const result = spawnSync(command, args, {stdio: ['ignore', ...descriptors], timeout: 30000,
        env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'}});
      if (result.error) throw result.error;
      assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
      return fs.readFileSync(files[0], 'utf8');
    } finally { descriptors.forEach(descriptor => fs.closeSync(descriptor)); }
  }
  try {
    const methods = []; let changed = 0;
    variants.forEach((source, index) => {
      const next = recover(guards(source), {parameterNames: ['mode', 'input', 'metric']});
      changed += next.rewrites;
      assert.equal(recover(next.source, {parameterNames: ['mode', 'input', 'metric']}).rewrites, 0);
      for (const [name, body] of [['original', source], ['rebuilt', next.source]])
        methods.push(`static void ${name}${index}(int mode,int input,float metric){${body}}`);
    });
    assert.ok(changed >= 10);
    const java = `public class PostGuardExits {
      static StringBuilder trace;static int failures,effects,cleanups,selector;static Object lock;
      static final RuntimeException specific=new IllegalArgumentException();static final Error fatal=new AssertionError();
      static void step(String s){trace.append(s).append('/');effects++;if(failures==1&&effects==1||failures==2&&effects==2)throw specific;}
      static void cleanup(){trace.append("cleanup/");cleanups++;if(failures==3)throw fatal;}
      static boolean predicate(){trace.append("predicate/");if(failures==4)throw specific;return(selector&1)!=0;}
      static boolean other(){trace.append("other/");return(selector&2)!=0;}
      ${methods.join('\n')}
      interface Call{void run();}
      static String invoke(Call call,int input,boolean nullLock){trace=new StringBuilder();effects=0;cleanups=0;selector=input;lock=nullLock?null:new Object();String result;
        try{call.run();result="ok";}catch(Throwable failure){result=failure==specific?"specific":failure==fatal?"fatal":failure.getClass().getSimpleName();}
        if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+effects+":"+cleanups+":"+trace;}
      static void oracle(Call call,int input,boolean nullLock,String expected){String actual=invoke(call,input,nullLock);if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);}
      public static void main(String[] ignored){int comparisons=0;failures=0;
        oracle(()->rebuilt0(0,1,0),1,false,"ok:2:0:predicate/A/tail/");
        oracle(()->rebuilt0(0,0,0),0,false,"ok:2:0:predicate/B/tail/");
        oracle(()->rebuilt5(0,1,0),1,false,"ok:2:1:predicate/A/cleanup/tail/");
        oracle(()->rebuilt6(0,1,0),1,true,"NullPointerException:0:0:");
        oracle(()->rebuilt9(0,0,Float.NaN),0,false,"ok:1:0:tail/");
        oracle(()->rebuilt9(0,0,-1),0,false,"ok:3:0:A/A/tail/");
        oracle(()->rebuilt10(0,1,0),1,false,"ok:1:0:predicate/A/");
        oracle(()->rebuilt11(0,1,0),1,false,"ok:2:0:B/tail/");
        oracle(()->rebuilt11(0,0,0),0,false,"ok:2:0:A/tail/");
        failures=3;oracle(()->rebuilt12(0,1,0),1,false,"fatal:1:1:predicate/A/cleanup/");
        for(failures=0;failures<5;failures++)for(int mode:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})
        for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(boolean nullLock:new boolean[]{false,true})
        for(float metric:new float[]{Float.NaN,Float.NEGATIVE_INFINITY,-1,-0.0f,Float.POSITIVE_INFINITY}){
          ${variants.map((_, index) => `{String expected=invoke(()->original${index}(mode,input,metric),input,nullLock),actual=invoke(()->rebuilt${index}(mode,input,metric),input,nullLock);if(!expected.equals(actual))throw new AssertionError("variant${index}:"+failures+":"+mode+":"+input+":"+metric+":"+expected+" != "+actual);comparisons++;}`).join('\n')}
        }if(comparisons!=25200)throw new AssertionError(comparisons);System.out.println("post-guard-exits-native:"+comparisons+":oracles:10");
      }
    }`;
    const file = path.join(directory, 'PostGuardExits.java'); fs.writeFileSync(file, java);
    run('javac', ['--release', '8', '-d', directory, file]);
    console.log(run('java', ['-cp', directory, 'PostGuardExits']).trim());
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
