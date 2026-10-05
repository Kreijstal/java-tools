'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {finalizeControlFrames: finish, finalizeTerminalSwitchFrames: finishSwitches,
  foldRedundantExitGuards: foldGuards} = require('../src/decompiler/javaAstEmitter');

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

test('redundant primitive exit guards preserve snapshots and exact exit spelling', () => {
  const cases = [
    ['int flag=read();while(more()){if(flag==0)break;break;}after();', 'int flag=read();while(more()){break;}after();'],
    ['int flag=read();Outer:while(more()){if(flag!=0)continue Outer;continue Outer;}after();', 'int flag=read();Outer:while(more()){continue Outer;}after();'],
    ['int flag=read();Exit:{if(flag<0){{break Exit;}}else{{break Exit;}}}after();', 'int flag=read();Exit:{break Exit;}after();'],
    ['int flag=read();if(flag>0){return;}else{return;}', 'int flag=read();return;'],
    ['int flag=read();while(more()){if(flag==0)break;else ;break;}after();', 'int flag=read();while(more()){break;}after();'],
    ['int flag=read();while(more()){if(flag==0){break;}else{}break;}after();', 'int flag=read();while(more()){break;}after();'],
    ['int flag=read();while(more()){flag++;if(((flag*2+1)&3)!=0)continue;continue;}after();', 'int flag=read();while(more()){flag++;continue;}after();'],
  ];
  for (const [source, expected] of cases) {
    const result = foldGuards(source);
    assert.equal(result.guardsRemoved, 1, source); assert.equal(result.source, expected);
    assert.deepEqual(foldGuards(expected), {source: expected, guardsRemoved: 0});
  }
});

test('case fallthrough permits guard removal only at an immediate matching exit', () => {
  const source = 'int flag=read();switch(key){case 0:work();if(flag==0){break;}case 1:default:break;}after();';
  assert.equal(foldGuards(source).source, 'int flag=read();switch(key){case 0:work();case 1:default:break;}after();');
  for (const body of [
    'switch(key){case 0:if(flag==0)break;case 1:work();break;}',
    'Outer:while(more()){switch(key){default:if(flag==0)break;break Outer;}}',
    'Outer:while(more()){if(flag==0)continue Outer;break Outer;}',
    'Outer:while(more()){if(flag==0)break Outer;break;}',
    'Outer:while(more()){if(flag==0)continue Outer;continue;}',
    'Outer:{Inner:{if(flag==0)break Inner;}break Outer;}',
    'while(more()){if(flag==0){try{break;}finally{cleanup();}}break;}',
  ]) {
    const unchanged = 'int flag=read();' + body + 'after();';
    assert.equal(foldGuards(unchanged).source, unchanged, body);
  }
});

test('only explicitly scoped primitive operands admit effect-free guard evaluation', () => {
  for (const [type, predicate] of [
    ['boolean', 'flag'], ['byte', 'flag==0'], ['short', 'flag<0'], ['char', "flag=='x'"],
    ['int', '((flag<<1)^~flag)!=0'], ['long', 'flag*0x7fffffffL!=0L'],
    ['float', 'flag!=flag'], ['double', 'flag>=flag'],
  ]) {
    const source = `while(more()){if(${predicate})break;break;}after();`;
    assert.equal(foldGuards(source, {parameters: [{name: 'flag', type}]}).guardsRemoved, 1, type);
    assert.equal(foldGuards(source).source, source, 'unknown operands are not inferred');
  }
  for (const source of [
    'Integer flag=read();while(more()){if(flag==0)break;break;}',
    'Boolean flag=read();while(more()){if(flag)break;break;}',
    'var flag=read();while(more()){if(flag==0)break;break;}',
    'int flag[]=read();while(more()){if(flag[0]==0)break;break;}',
    '{int flag=read();}while(more()){if(flag==0)break;break;}',
    'while(more()){if(flag==0)break;break;}int flag=read();',
    '{int flag=read();}int flag=read();while(more()){if(flag==0)break;break;}',
  ]) assert.equal(foldGuards(source).source, source, source);
  const collision = 'int flag=read();while(more()){if(flag==0)break;break;}';
  assert.equal(foldGuards(collision, {parameters: [{name: 'flag', type: 'int'}]}).source, collision);
});

test('calls, fields, arrays, unboxing and failing or mutating expressions remain', () => {
  for (const predicate of [
    'test()', 'state.flag==0', 'flag==0', 'array[0]==0', '(Integer)value==0',
    'boxed==0', 'flag/other==0', 'flag%other==0', 'flag++==0', '++flag==0',
    '(flag=other)==0', 'flag==0&&test()', 'test()||flag==0',
    'flag==0?true:test()', '"text"==value', '(int)value==0',
  ]) {
    const declarations = predicate === 'flag==0' ? '' : 'int flag=read(),other=read();';
    const source = `${declarations}while(more()){if(${predicate})break;break;}after();`;
    assert.equal(foldGuards(source, {parameters: [{name: 'boxed', type: 'Integer'}, {name: 'value', type: 'Object'}]}).source, source, predicate);
  }
});

test('guard diagnostics account for every deleted character and fixed point step', () => {
  let source = 'int flag=read();\nExit:{\n    if(flag==0){break Exit;}\n    if(flag!=0){break Exit;}\n    break Exit;\n}\nafter();';
  let removed = 0;
  for (;;) {
    const result = foldGuards(source, {retainDiagnostics: true});
    if (!result.guardsRemoved) break;
    let reconstructed = source;
    for (const {start, end} of result.diagnostics.deletedRanges.slice().reverse()) {
      assert.ok(start >= 0 && end > start && end <= source.length);
      reconstructed = reconstructed.slice(0, start) + reconstructed.slice(end);
    }
    assert.equal(reconstructed, result.source);
    assert.equal(result.diagnostics.removedGuards.length, result.guardsRemoved);
    for (const guard of result.diagnostics.removedGuards) {
      assert.equal(source.slice(guard.start, guard.start + 2), 'if');
      assert.match(source.slice(guard.conditionStart, guard.conditionEnd), /^flag[!=]=0$/);
      assert.equal(guard.exitKind, 'BreakStatement'); assert.equal(guard.exitLabel, 'Exit');
      assert.equal(guard.bothArms, false);
    }
    removed += result.guardsRemoved; source = result.source;
  }
  assert.equal(removed, 2); assert.equal(source, 'int flag=read();\nExit:{\n    break Exit;\n}\nafter();');
  const both = foldGuards('int flag=read();Exit:{if(flag==0){break Exit;}else{break Exit;}}', {retainDiagnostics: true});
  assert.equal(both.diagnostics.deletedRanges.length, 2); assert.equal(both.diagnostics.removedGuards[0].bothArms, true);
});

test('uncertain syntax, nested execution and invalid options refuse guard cleanup', () => {
  for (const source of [
    'int flag=read();while(more()){42;if(flag==0)break;break;}',
    'int flag=read();while(more()){work() if(flag==0)break;break;}',
    'int flag=read();while(more()){if(flag==0)break Missing;break Missing;}',
    'int flag=read();Exit:{if(flag==0)break Exit;break Exit;}Exit:{}',
    'int flag=read();while(more()){if(flag==0)break;break;} // diagnostic\n',
    'int flag=read();while(more()){if(flag==0)break;break;}\\u000a',
    'int flag=read();class Inner{void run(){}}while(more()){if(flag==0)break;break;}',
    'int flag=read();Runnable task=()->work();while(more()){if(flag==0)break;break;}',
    'int flag=read();switch(key){case 0 -> {if(flag==0)break;break;}}',
    'int flag=read();while(more()){if(flag==0)break;break;}' + ' '.repeat(400001),
  ]) assert.equal(foldGuards(source).source, source, source.slice(0, 100));
  const source = 'while(more()){if(flag==0)break;break;}';
  for (const parameters of [null, {}, [null], [{name: 'flag', type: 0}], [{name: 'bad name', type: 'int'}],
    [{name: 'flag', type: 'int'}, {name: 'flag', type: 'int'}]]) assert.equal(foldGuards(source, {parameters}).source, source);
  assert.equal(foldGuards(source, {retainDiagnostics: 1}).source, source);
});

test('redundant guards match independent native completion and event models', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'redundant-guard-native-'));
  const variants = [
    "int saved=capture(c,flag,fail);switch(mode){case 0:emit(c,'a',fail);if(saved==0)break;case 1:break;default:emit(c,'d',fail);break;}emit(c,'q',fail);",
    "int saved=capture(c,flag,fail);Exit:{emit(c,'a',fail);if(saved<0){{break Exit;}}else{{break Exit;}}}emit(c,'q',fail);",
    "int saved=capture(c,flag,fail);for(int i=0;i<3;i++){emit(c,'a',fail);saved++;if(((saved*31)^flag)!=0)continue;continue;}emit(c,'q',fail);",
    "int saved=capture(c,flag,fail);while(true){emit(c,'a',fail);if(saved==0)break;break;}emit(c,'q',fail);",
    "try{emit(c,'a',fail);return;}finally{emit(c,'f',fail);if(flag!=0)return;return;}",
    "Exit:{try{emit(c,'a',fail);throw new IllegalArgumentException(\"body\");}finally{synchronized(c.lock){emit(c,'f',fail);if(flag==0){break Exit;}break Exit;}}}emit(c,'q',fail);",
    "if((value!=value || value<flag) && flag>=0)return;return;",
    "Exit:{emit(c,'a',fail);if(test(c,flag,fail))break Exit;break Exit;}emit(c,'q',fail);",
    "Exit:{emit(c,'a',fail);if(flag/divisor==0)break Exit;break Exit;}emit(c,'q',fail);",
    "Exit:{emit(c,'a',fail);if(boxed==0)break Exit;break Exit;}emit(c,'q',fail);",
  ];
  const models = [
    "capture(c,flag,fail);if(mode==0)emit(c,'a',fail);else if(mode!=1)emit(c,'d',fail);emit(c,'q',fail);",
    "capture(c,flag,fail);emit(c,'a',fail);emit(c,'q',fail);",
    "capture(c,flag,fail);emit(c,'a',fail);emit(c,'a',fail);emit(c,'a',fail);emit(c,'q',fail);",
    "capture(c,flag,fail);emit(c,'a',fail);emit(c,'q',fail);",
    "try{emit(c,'a',fail);}finally{emit(c,'f',fail);return;}",
    "try{emit(c,'a',fail);}catch(RuntimeException ignored){}synchronized(c.lock){emit(c,'f',fail);}emit(c,'q',fail);",
    "return;",
    "emit(c,'a',fail);test(c,flag,fail);emit(c,'q',fail);",
    "emit(c,'a',fail);int ignored=flag/divisor;emit(c,'q',fail);",
    "emit(c,'a',fail);int ignored=boxed.intValue();emit(c,'q',fail);",
  ];
  const parameters = [{name: 'flag', type: 'int'}, {name: 'mode', type: 'int'}, {name: 'fail', type: 'int'},
    {name: 'value', type: 'double'}, {name: 'boxed', type: 'Integer'}, {name: 'divisor', type: 'int'}];
  try {
    const rewritten = variants.map(source => foldGuards(source, {parameters}));
    assert.deepEqual(rewritten.map(result => result.guardsRemoved), [1, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
    const signature = '(Ctx c,int flag,int mode,int fail,double value,Integer boxed,int divisor)';
    const methods = variants.flatMap((source, index) => [
      `static void original${index}${signature}{${source}}`,
      `static void rewritten${index}${signature}{${rewritten[index].source}}`,
      `static void model${index}${signature}{${models[index]}}`,
    ]).join('\n');
    const file = path.join(temporary, 'RedundantGuardNative.java');
    fs.writeFileSync(file, `public final class RedundantGuardNative {
      static final class Ctx {int count,hash;final Object lock=new Object();final StringBuilder trace=new StringBuilder();Ctx(int seed){hash=seed;}}
      interface Eval {void run(Ctx c,int flag,int mode,int fail,double value,Integer boxed,int divisor);}
      static void emit(Ctx c,char event,int fail){c.count++;c.hash=c.hash*31+event;c.trace.append(event).append(Thread.holdsLock(c.lock)?'L':'_');if(c.count==fail)throw new IllegalStateException("event"+c.count);}
      static int capture(Ctx c,int flag,int fail){emit(c,'s',fail);return flag;}
      static boolean test(Ctx c,int flag,int fail){emit(c,'t',fail);return flag==0;}
      static String invoke(Eval eval,int flag,int mode,int fail,double value,Integer boxed,int divisor,int seed){Ctx c=new Ctx(seed);String result="return:void";try{eval.run(c,flag,mode,fail,value,boxed,divisor);}catch(RuntimeException failure){result=failure.getClass().getName()+":"+failure.getMessage();}if(Thread.holdsLock(c.lock))throw new AssertionError("monitor leaked");return result+":"+c.count+":"+c.hash+":"+c.trace;}
      ${methods}
      public static void main(String[] args){
        Eval[] original={${variants.map((_, index) => 'RedundantGuardNative::original' + index).join(',')}};
        Eval[] rewritten={${variants.map((_, index) => 'RedundantGuardNative::rewritten' + index).join(',')}};
        Eval[] model={${variants.map((_, index) => 'RedundantGuardNative::model' + index).join(',')}};
        int cases=0;
        for(int variant=0;variant<original.length;variant++)for(int flag:new int[]{-2,0,1,Integer.MIN_VALUE,Integer.MAX_VALUE})for(int mode=0;mode<4;mode++)for(int fail=0;fail<5;fail++)for(double value:new double[]{Double.NEGATIVE_INFINITY,-0.0,0.0,Double.NaN,Double.POSITIVE_INFINITY,Double.MIN_VALUE,Double.MAX_VALUE,1.0})for(Integer boxed:new Integer[]{null,0,1})for(int divisor:new int[]{-1,0,1,Integer.MAX_VALUE})for(int seed:new int[]{0,Integer.MAX_VALUE}){
          String expected=invoke(model[variant],flag,mode,fail,value,boxed,divisor,seed),before=invoke(original[variant],flag,mode,fail,value,boxed,divisor,seed),after=invoke(rewritten[variant],flag,mode,fail,value,boxed,divisor,seed);
          if(!expected.equals(before)||!expected.equals(after))throw new AssertionError(variant+":"+flag+":"+mode+":"+fail+":"+value+":"+boxed+":"+divisor+":"+seed+" expected="+expected+" before="+before+" after="+after);
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
    // Repeated implicit divide/unboxing failures otherwise acquire null
    // messages at different JIT warmup counts in the three independent methods.
    assert.equal(run('java', ['-XX:-OmitStackTraceInFastThrow', '-cp', temporary, 'RedundantGuardNative']), 'oracle-complete:192000:10');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
