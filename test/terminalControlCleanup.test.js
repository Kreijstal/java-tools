'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {finalizeControlFrames: finish, finalizeTerminalSwitchFrames: finishSwitches} = require('../src/decompiler/javaAstEmitter');

test('late fallthrough exits lose their unused frame while guards and actions remain', () => {
  const source = 'while(true){Phase:{if(more()){step();if(flag==0)continue;}else{done();break Phase;}}tail();break;}after();';
  const result = finish(source);
  assert.equal(result.breaksRemoved, 1);
  assert.equal(result.labelsRemoved, 1);
  assert.equal(result.blocksUnwrapped, 1);
  assert.equal(result.source, 'while(true){if(more()){step();if(flag==0)continue;}else{done();}tail();break;}after();');
  assert.deepEqual(finish(result.source), {source: result.source, breaksRemoved: 0,
    labelsRemoved: 0, jumpsUnlabeled: 0, blocksUnwrapped: 0});
});

test('cleanup retains declaration scopes and early exits that skip actions', () => {
  const source = 'Exit:{int value=read();if(skip())break Exit;if(pick()){use(value);break Exit;}}after();';
  const result = finish(source);
  assert.equal(result.breaksRemoved, 1);
  assert.equal(result.labelsRemoved, 0);
  assert.equal(result.source, 'Exit:{int value=read();if(skip())break Exit;if(pick()){use(value);}}after();');
  const scoped = finish('Exit:{int value=read();if(pick()){use(value);break Exit;}}after();');
  assert.equal(scoped.labelsRemoved, 1);
  assert.equal(scoped.blocksUnwrapped, 0);
  assert.equal(scoped.source, '{int value=read();if(pick()){use(value);}}after();');
});

test('protected completion and pending finally transfers remain opaque', () => {
  for (const source of [
    'Exit:{try{work();break Exit;}finally{cleanup();}}after();',
    'Exit:{try{return value();}finally{break Exit;}}after();',
    'Exit:{try{work();}catch(RuntimeException failure){break Exit;}}after();',
    'Exit:{synchronized(lock){work();break Exit;}}after();',
    'Exit:{while(more()){work();break Exit;}}after();',
    'Exit:{switch(key){default:break Exit;}}after();',
  ]) assert.equal(finish(source).source, source);
  const source = 'try{Exit:{if(pick()){work();break Exit;}}}finally{cleanup();}after();';
  assert.equal(finish(source).source, 'try{if(pick()){work();}}finally{cleanup();}after();');
});

test('ambiguous syntax, nested execution and diagnostics do not admit late cleanup', () => {
  for (const source of [
    'Exit:{work();break Exit;} // diagnostics\n',
    'Exit:{work();break Exit;}\\u000a',
    'Exit:{work();break Missing;}',
    'Exit:{class Inner{void run(){}}work();break Exit;}',
    'Exit:{work();break Exit;}Exit:{}',
    'Exit:{work();break Exit;}' + ' '.repeat(400001),
  ]) assert.equal(finish(source).source, source);
});

test('terminal switch exits retain cases, guards, callbacks and fallthrough', () => {
  const source = 'Exit:{before();switch(key){case 0:a();if(flag==0)break Exit;b();break;case 1:c();if(flag!=0)break Exit;default:d();break Exit;}}after();';
  const result = finishSwitches(source);
  assert.deepEqual(result, {source: 'before();switch(key){case 0:a();if(flag==0)break;b();break;case 1:c();if(flag!=0)break;default:d();break;}after();',
    breaksLocalized: 3, labelsRemoved: 1, jumpsUnlabeled: 0, blocksUnwrapped: 1});
  assert.deepEqual(finishSwitches(result.source), {source: result.source, breaksLocalized: 0, labelsRemoved: 0, jumpsUnlabeled: 0, blocksUnwrapped: 0});
});

test('terminal switches retain shared frames and declaration scopes', () => {
  const shared = 'Exit:{if(skip())break Exit;switch(key){default:if(stop())break Exit;work();}}after();';
  const result = finishSwitches(shared);
  assert.deepEqual(result, {source: 'Exit:{if(skip())break Exit;switch(key){default:if(stop())break;work();}}after();',
    breaksLocalized: 1, labelsRemoved: 0, jumpsUnlabeled: 0, blocksUnwrapped: 0});
  const scoped = finishSwitches('Exit:{int saved=read();switch(key){default:use(saved);break Exit;}}after();');
  assert.equal(scoped.source, '{int saved=read();switch(key){default:use(saved);break;}}after();');
  assert.equal(scoped.labelsRemoved, 1); assert.equal(scoped.blocksUnwrapped, 0);
  const conditional = finishSwitches('Exit:{if(pick()){switch(key){default:work();break Exit;}}else{other();}}after();');
  assert.equal(conditional.source, 'if(pick()){switch(key){default:work();break;}}else{other();}after();');
});

test('switch exit localization rejects work or protected completion between destinations', () => {
  for (const source of [
    'Exit:{switch(key){default:break Exit;}work();}after();',
    'Exit:{if(pick()){switch(key){default:break Exit;}work();}}after();',
    'Exit:{try{switch(key){default:break Exit;}}finally{cleanup();}}after();',
    'Exit:{try{switch(key){default:break Exit;}}catch(RuntimeException failure){recover();}}after();',
    'Exit:{synchronized(lock){switch(key){default:break Exit;}}}after();',
    'Exit:{while(more()){switch(key){default:break Exit;}}}after();',
    'Exit:{switch(key){default:while(more()){break Exit;}}}after();',
    'Outer:while(more()){switch(key){default:break Outer;}}after();',
    'Exit:{switch(key){default:break Missing;}}after();',
    'Exit:{switch(key){default:break Exit;}}/* diagnostic */',
    'Exit:{switch(key){default:break Exit;}}\\u000a',
    'Exit:{class Inner{void run(){}}switch(key){default:break Exit;}}after();',
  ]) assert.equal(finishSwitches(source).source, source, source);
});

test('switch exits keep inner protected transfers and enclosing protection intact', () => {
  const source = 'try{Exit:{switch(key){case 0:try{return value();}finally{break Exit;}default:synchronized(lock){work();break Exit;}}}}finally{cleanup();}after();';
  assert.equal(finishSwitches(source).source, 'try{switch(key){case 0:try{return value();}finally{break;}default:synchronized(lock){work();break;}}}finally{cleanup();}after();');
});

test('terminal switch frames match independent native event and completion models', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-switch-native-'));
  const variants = [
    "Exit:{emit(c,'p',fail);switch(key){case 0:emit(c,'a',fail);if(flag==0)break Exit;emit(c,'b',fail);break;case 1:emit(c,'d',fail);if(flag!=0)break Exit;default:emit(c,'e',fail);break Exit;}}emit(c,'q',fail);return c.hash;",
    "Exit:{emit(c,'p',fail);if((mode&1)==0){switch(key){case 0:emit(c,'a',fail);if(flag==0)break Exit;default:emit(c,'b',fail);break Exit;}}else{emit(c,'d',fail);}}emit(c,'q',fail);return c.hash;",
    "Exit:{emit(c,'p',fail);if((mode&1)!=0)break Exit;switch(key){case 0:for(int i=0;i<2;i++){emit(c,'a',fail);if(flag==0)break Exit;}emit(c,'b',fail);break;default:emit(c,'e',fail);break Exit;}}emit(c,'q',fail);return c.hash;",
    "Exit:{emit(c,'p',fail);switch(key){case 0:try{emit(c,'a',fail);if((mode&1)==0)return c.hash;throw new IllegalArgumentException(\"body\");}finally{emit(c,'f',fail);if((mode&2)==0)break Exit;}case 1:synchronized(c.lock){emit(c,'l',fail);if(flag==0)break Exit;emit(c,'m',fail);}break;default:emit(c,'d',fail);break Exit;}}emit(c,'q',fail);return c.hash;",
    "try{Exit:{emit(c,'p',fail);switch(key){case 0:emit(c,'a',fail);if(flag==0)break Exit;emit(c,'b',fail);break;case 1:emit(c,'d',fail);if(flag!=0)break Exit;default:emit(c,'e',fail);break Exit;}}emit(c,'q',fail);}catch(IllegalStateException failure){emit(c,'c',fail);throw new IllegalArgumentException(\"wrapped:\"+failure.getMessage());}finally{emit(c,'f',fail);}return c.hash;",
    "Exit:{try{switch(key){case 0:emit(c,'a',fail);break Exit;default:emit(c,'b',fail);break;}}finally{emit(c,'f',fail);}emit(c,'d',fail);}emit(c,'q',fail);return c.hash;",
  ];
  const models = [
    "emit(c,'p',fail);if(key==0){emit(c,'a',fail);if(flag!=0)emit(c,'b',fail);}else if(key==1){emit(c,'d',fail);if(flag==0)emit(c,'e',fail);}else emit(c,'e',fail);emit(c,'q',fail);return c.hash;",
    "emit(c,'p',fail);if((mode&1)==0){if(key==0)emit(c,'a',fail);if(key!=0||flag!=0)emit(c,'b',fail);}else emit(c,'d',fail);emit(c,'q',fail);return c.hash;",
    "emit(c,'p',fail);if((mode&1)==0){if(key==0){emit(c,'a',fail);if(flag!=0){emit(c,'a',fail);emit(c,'b',fail);}}else emit(c,'e',fail);}emit(c,'q',fail);return c.hash;",
    "emit(c,'p',fail);if(key==0){Integer pendingValue=null;RuntimeException pendingFailure=null;try{emit(c,'a',fail);if((mode&1)==0)pendingValue=c.hash;else pendingFailure=new IllegalArgumentException(\"body\");}catch(RuntimeException failure){pendingFailure=failure;}emit(c,'f',fail);if((mode&2)!=0){if(pendingFailure!=null)throw pendingFailure;return pendingValue;}}else if(key==1){synchronized(c.lock){emit(c,'l',fail);if(flag!=0)emit(c,'m',fail);}}else emit(c,'d',fail);emit(c,'q',fail);return c.hash;",
    "try{model0(c,key,flag,mode,fail);}catch(IllegalStateException failure){emit(c,'c',fail);throw new IllegalArgumentException(\"wrapped:\"+failure.getMessage());}finally{emit(c,'f',fail);}return c.hash;",
    "RuntimeException pendingFailure=null;try{emit(c,key==0?'a':'b',fail);}catch(RuntimeException failure){pendingFailure=failure;}emit(c,'f',fail);if(pendingFailure!=null)throw pendingFailure;if(key!=0)emit(c,'d',fail);emit(c,'q',fail);return c.hash;",
  ];
  try {
    const rewritten = variants.map(source => finishSwitches(source));
    assert.deepEqual(rewritten.map(result => result.breaksLocalized), [3, 2, 1, 3, 3, 0]);
    assert.equal(rewritten[2].labelsRemoved, 0, 'shared outer-loop and early exits keep the frame');
    assert.equal(rewritten[5].source, variants[5], 'normal and abrupt finally completion cannot be conflated');
    const methods = variants.flatMap((source, index) => [
      `static int original${index}(Ctx c,int key,int flag,int mode,int fail){${source}}`,
      `static int rewritten${index}(Ctx c,int key,int flag,int mode,int fail){${rewritten[index].source}}`,
      `static int model${index}(Ctx c,int key,int flag,int mode,int fail){${models[index]}}`,
    ]).join('\n');
    const file = path.join(temporary, 'TerminalSwitchNative.java');
    fs.writeFileSync(file, `public final class TerminalSwitchNative {
      static final class Ctx {int count,hash;final Object lock=new Object();final StringBuilder trace=new StringBuilder();Ctx(int seed){hash=seed;}}
      interface Eval {int run(Ctx c,int key,int flag,int mode,int fail);}
      static void emit(Ctx c,char event,int fail){c.count++;c.hash=c.hash*31+event;c.trace.append(event).append(Thread.holdsLock(c.lock)?'L':'_');if(c.count==fail)throw new IllegalStateException("event"+c.count);}
      static String invoke(Eval eval,int key,int flag,int mode,int fail,int seed){Ctx c=new Ctx(seed);String result;try{result="return:"+eval.run(c,key,flag,mode,fail);}catch(RuntimeException failure){result=failure.getClass().getName()+":"+failure.getMessage();}if(Thread.holdsLock(c.lock))throw new AssertionError("monitor leaked");return result+":"+c.count+":"+c.hash+":"+c.trace;}
      ${methods}
      public static void main(String[] args){
        Eval[] original={${variants.map((_, index) => 'TerminalSwitchNative::original' + index).join(',')}};
        Eval[] rewritten={${variants.map((_, index) => 'TerminalSwitchNative::rewritten' + index).join(',')}};
        Eval[] model={${variants.map((_, index) => 'TerminalSwitchNative::model' + index).join(',')}};
        int cases=0;
        for(int variant=0;variant<original.length;variant++)for(int key:new int[]{-1,0,1,2,3,4,Integer.MIN_VALUE,Integer.MAX_VALUE})for(int flag:new int[]{-2,0,1,Integer.MIN_VALUE,Integer.MAX_VALUE})for(int mode=0;mode<8;mode++)for(int fail=0;fail<=12;fail++)for(int seed:new int[]{0,Integer.MAX_VALUE}){
          String expected=invoke(model[variant],key,flag,mode,fail,seed),before=invoke(original[variant],key,flag,mode,fail,seed),after=invoke(rewritten[variant],key,flag,mode,fail,seed);
          if(!expected.equals(before)||!expected.equals(after))throw new AssertionError(variant+":"+key+":"+flag+":"+mode+":"+fail+":"+seed+" expected="+expected+" before="+before+" after="+after);
          cases++;
        }
        System.out.println("oracle-complete:"+cases+":"+original.length);
      }
    }`);
    const run = (command, args) => {
      const result = spawnSync(command, args, {encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return result.stdout.trim();
    };
    run('javac', ['--release', '8', '-d', temporary, file]);
    assert.equal(run('java', ['-cp', temporary, 'TerminalSwitchNative']), 'oracle-complete:49920:6');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
