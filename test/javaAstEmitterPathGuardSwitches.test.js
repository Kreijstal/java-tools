'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {specializePathGuards: fold, simplifyControlFrames: clean,
  recoverPostGuardExits: exits} = require('../src/decompiler/javaAstEmitter');

function recover(source) {
  let changes = 0;
  for (let limit = 0; limit < 128; limit++) {
    const next = fold(source, {parameterNames: ['mode', 'input']});
    if (!next.guardsSpecialized) return {source, changes};
    source = next.source; changes++;
  }
  assert.fail('guard recovery did not reach a fixed point');
}

test('colon switches preserve independent entry facts and ordinary completion', () => {
  for (const source of [
    'int guard=mode;if(guard==0){if(guard==0)step("A");}switch(input){case 0:break;default:break;}',
    'int guard=mode;switch(input){case 0:if(guard!=0)break;if(guard==0)step("A");break;default:break;}',
    'int guard=mode;switch(input){case 0:case 1:if(guard==0){if(guard==0)step("A");}break;default:}',
    'int guard=mode;switch(input){case (true?0:1):if(guard==0){if(guard==0)step("A");}break;default:break;}',
    'int guard=mode;switch(input){case 0:guard=input;break;default:if(guard==0){if(guard==0)step("A");}}',
    'int guard=mode;switch(input){case 0: {if(guard==0){if(guard==0)step("A");}}break;default:break;}',
    'int guard=mode;switch(input){case 0:for(int index=0;index<2;index++){if(guard!=0)break;if(guard==0)continue;}break;default:break;}',
  ]) {
    const next = recover(source);
    assert.ok(next.changes > 0, source);
    assert.equal(fold(next.source).guardsSpecialized, 0);
  }
  const outside = 'int guard=mode;if(guard!=0)return;switch(input){case 0:{if(guard==0)return;step("bad-case");break;}default:return;}step("bad-tail");';
  const next = recover(outside);
  assert.ok(next.changes > 0);
  assert.ok(!next.source.includes('bad-case'));
  assert.ok(!next.source.includes('bad-tail'), 'all switch entries return after specialization');
  const withoutDefault = outside.replace('default:return;', '');
  assert.ok(recover(withoutDefault).source.includes('bad-tail'), 'a missing default permits normal completion');
});

test('switch facts never cross a case entry, and shared case-group scope remains guarded', () => {
  for (const source of [
    'int guard=mode;switch(input){case 0:if(guard!=0)break;step("zero");case 1:if(guard==0)step("A");break;default:break;}',
    'int guard=mode;switch(input){case 0:if(guard!=0)break;step("zero");default:if(guard==0)step("A");}',
    'int guard=mode;switch(input){case 0:if(guard==0){guard=input;if(guard==0)step("A");}break;default:break;}',
    'int guard=mode;switch(input){case 0:if(guard!=0)break;if(guard==0)break;step("suffix");default:break;}',
    'int guard=mode;switch(input){case 0:if(guard!=0)break;if(guard==0)break;int local=1;step(local);default:break;}',
    'int guard=mode;switch(input){case 0:if(guard==0){if(guard!=0){int local=1;step(local);}}break;default:break;}',
    'int guard=mode;switch(input){case 0:try{if(guard==0){if(guard==0)step("A");}checked();}catch(java.io.IOException failure){step("caught");}break;default:break;}',
  ]) assert.deepEqual(fold(source), {source, guardsSpecialized: 0}, source);
});

test('unsupported switch rules and incomplete lexical boundaries refuse the whole rewrite', () => {
  const prefix = 'int guard=mode;if(guard==0){if(guard==0)step("A");}';
  for (const suffix of [
    'switch(input){case 0 -> step("A");default -> step("B");}',
    'switch(input){case 0 step("A");default:break;}',
    'switch(input){case 0:break;default break;}',
    'switch(input){step("A");case 0:break;}',
    'switch(input){case 0:step("A") default:break;}',
    'switch(input){case 0:break;default:break;',
    'switch(input){case 0:continue;default:break;}',
    'switch(input){case 0:break Missing;default:break;}',
    'switch(input){case true?0:1:break;default:break;}',
  ]) {
    const source = prefix + suffix;
    assert.deepEqual(fold(source), {source, guardsSpecialized: 0}, source);
  }
});

test('native switch guards retain fallthrough, selectors, transfers, throwing cleanup and monitors', () => {
  const variants = [
    'int guard=mode;if(guard==0){if(guard==0)step("A");}switch(select(input)){case 0:step("zero");break;default:step("default");}step("tail");',
    'int guard=mode;switch(select(input)){case 0:step("zero");break;default:step("default");}if(guard==0){if(guard==0)step("A");}step("tail");',
    'int guard=mode;switch(select(input)){case 0:if(guard!=0)break;if(guard==0)step("A");case 1:step("fallthrough");break;default:step("default");}step("tail");',
    'int guard=mode;if(guard==0){if(guard==0)step("A");}switch(select(input)){case 0:return;case 1:throw specific;}step("tail");',
    'int guard=mode;if(guard==0){if(guard==0)step("A");}switch(select(input)){case 0:return;default:}step("tail");',
    'int guard=mode;if(guard==0){if(guard==0)step("A");}switch(select(input)){case 0:break;default:step("default");case 1:return;}step("tail");',
    'int guard=mode;if(guard==0){if(guard==0)step("A");}Outer:for(int index=0;index<2;index++){switch(select(input)){case 0:for(int inner=0;inner<2;inner++){step("inner");break;}step("case");break;default:continue Outer;}step("loop");}step("tail");',
    'int guard=mode;Outer:{switch(select(input)){case 0:if(guard!=0)break Outer;if(guard==0)step("A");break;default:break;}step("outer");}step("tail");',
    'int guard=mode;int index=0;while(index++<2){switch(select(input)){case 0:if(guard!=0)break;if(guard==0)step("A");break;default:break;}step("loop");}step("tail");',
    'int guard=mode;switch(select(input)){case 0:try{if(guard==0){if(guard==0)step("A");}break;}finally{cleanup();if(input==7)return;}default:step("default");}step("tail");',
    'int guard=mode;if(guard!=0)return;switch(select(input)){case 0:{if(guard==0)return;step("bad-case");break;}default:return;}step("bad-tail");',
    'int guard=mode;Outer:for(int index=0;index<2;index++){switch(select(input)){case 0:{if(guard!=0)break;if(guard==0)continue Outer;step("bad-case");}case 1:step("fallthrough");break;default:break;}step("loop");}step("tail");',
    'int guard=mode;synchronized(lock){switch(select(input)){case 0:if(guard==0){if(guard==0)step("A"+Thread.holdsLock(lock));}break;default:break;}}step("tail");',
    'int guard=mode;switch(select(input)){case 0:if(guard!=0)break;step("zero");case 1:if(guard==0)step("A");break;default:break;}step("tail");',
    'int guard=mode;switch(select(input)){case 0:guard=input;break;default:if(guard==0){if(guard==0)step("A");}}step("tail");',
    'switch(select(input)){case 0:{int guard=mode;if(guard==0){if(guard==0)step("A");}}break;default:break;}step("tail");',
    'int guard=mode;switch(select(input)){case (true?0:2):case 1:if(guard==0){if(guard==0)step("A");}break;default:break;}step("tail");',
    'int guard=mode;switch(String.valueOf(select(input))){case "0":if(guard==0){if(guard==0)step("A");}break;default:break;}step("tail");',
    'int guard=mode;if(guard!=0)return;Outer:{switch(select(input)){case 0:try{break;}finally{if(guard==0)return;step("bad-cleanup");}default:return;}step("bad-outer");}step("bad-tail");',
    'int guard=mode;if(guard==0){if(guard==0)step("A");}Outer:for(int index=0;index<2;index++){switch(select(input)){case 0:try{continue Outer;}finally{cleanup();if(input==0)break;}default:step("default");}step("loop");}step("tail");',
    'int guard=mode;switch(select(input)){case 0:if(guard==0){guard=input;if(guard==0)step("A");}break;default:break;}step("tail");',
  ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-switch-native-'));
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
    const methods = [];
    variants.forEach((source, index) => {
      const next = recover(source);
      if (index === 13 || index === 20) assert.equal(next.changes, 0, 'case entry or mutation is not a fact');
      else assert.ok(next.changes > 0, index + ': ' + source);
      let composed = next.source;
      for (;;) { const result = clean(composed); if (result.source === composed) break; composed = result.source; }
      composed = exits(composed, {parameterNames: ['mode', 'input']}).source;
      for (const [name, body] of [['original', source], ['rebuilt', next.source], ['composed', composed]])
        methods.push(`static void ${name}${index}(int mode,int input){${body}}`);
    });
    const java = `public class PathGuardSwitches {
      static StringBuilder trace;static int failures,effects,cleanups,selections;static Object lock;
      static final RuntimeException specific=new IllegalArgumentException();static final Error fatal=new AssertionError();
      static void step(String s){trace.append(s).append('/');effects++;if(failures==1&&effects==1||failures==2&&effects==2)throw specific;}
      static void cleanup(){trace.append("cleanup/");cleanups++;if(failures==3)throw fatal;}
      static int select(int input){trace.append("select/");selections++;if(failures==4)throw specific;return input;}
      ${methods.join('\n')}
      interface Call{void run();}
      static String invoke(Call call,boolean nullLock){trace=new StringBuilder();effects=0;cleanups=0;selections=0;lock=nullLock?null:new Object();String result;try{call.run();result="ok";}catch(Throwable e){result=e==specific?"specific":e==fatal?"fatal":e.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("lock retained");return result+":"+effects+":"+cleanups+":"+selections+":"+trace;}
      static void oracle(Call call,String expected){String actual=invoke(call,false);if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);}
      public static void main(String[]args){int comparisons=0;
        oracle(()->composed0(0,0),"ok:3:0:1:A/select/zero/tail/");
        oracle(()->composed2(0,0),"ok:3:0:1:select/A/fallthrough/tail/");
        oracle(()->composed2(7,0),"ok:1:0:1:select/tail/");
        oracle(()->composed4(0,7),"ok:2:0:1:A/select/tail/");
        oracle(()->composed7(7,0),"ok:1:0:1:select/tail/");
        oracle(()->composed10(0,0),"ok:0:0:1:select/");
        oracle(()->composed11(0,0),"ok:1:0:2:select/select/tail/");
        oracle(()->composed12(0,0),"ok:2:0:1:select/Atrue/tail/");
        oracle(()->composed13(7,1),"ok:1:0:1:select/tail/");
        oracle(()->composed18(0,0),"ok:0:0:1:select/");
        for(failures=0;failures<5;failures++)for(int mode:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(boolean nullLock:new boolean[]{false,true}){
          ${variants.flatMap((_, i) => ['rebuilt', 'composed'].map(name => `{String expected=invoke(()->original${i}(mode,input),nullLock),actual=invoke(()->${name}${i}(mode,input),nullLock);if(!expected.equals(actual))throw new AssertionError("${name}${i}:"+failures+":"+mode+":"+input+":"+nullLock+":"+expected+" != "+actual);comparisons++;}`)).join('\n')}
        }if(comparisons!=15120)throw new AssertionError(comparisons);System.out.println("path-guard-switch-native:"+comparisons+",oracles:10");
      }
    }`;
    const file = path.join(directory, 'PathGuardSwitches.java');
    fs.writeFileSync(file, java);
    run('javac', ['--release', '8', '-d', directory, file]);
    console.log(run('java', ['-cp', directory, 'PathGuardSwitches']).trim());
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
