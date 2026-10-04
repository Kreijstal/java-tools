'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {foldGuardedAbruptPlainBlockExits: fold, simplifyControlFrames: clean,
  recoverPostGuardExits: compose} = require('../src/decompiler/javaAstEmitter');

function recover(source) {
  let frames = 0, jumps = 0;
  for (let limit = 0; limit < 128; limit++) {
    const next = fold(source);
    if (!next.jumpsRemoved) return {source, frames, jumps};
    source = next.source; frames += next.framesRemoved; jumps += next.jumpsRemoved;
  }
  assert.fail('guarded abrupt exit recovery did not reach a fixed point');
}

test('guarded abrupt exits retain scopes and invert only exact logical complements', () => {
  for (const [guard, expected] of [
    ['mode!=0', 'mode==0'], ['mode==0', 'mode!=0'], ['((mode!=0))', '((mode==0))'],
    ['metric>0', '!(metric>0)'], ['metric<=0', '!(metric<=0)'],
    ['boxed', '!(boxed)'], ['predicate(mode)', '!(predicate(mode))'],
  ]) {
    const source = `int prefix=1;Frame:{if(outer(input)){int local=prefix;step(local);if(${guard}){break Frame;}return value();}int fallback=prefix;step(fallback);}return 99;`;
    const next = fold(source);
    assert.equal(next.framesRemoved, 1, source);
    assert.equal(next.jumpsRemoved, 1);
    assert.ok(next.source.includes(expected), expected);
    assert.ok(next.source.includes('else {'));
    assert.ok(next.source.includes('int prefix=1;'));
    assert.ok(next.source.includes('int local=prefix;'));
    assert.ok(next.source.includes('int fallback=prefix;'));
    assert.equal(fold(next.source).framesRemoved, 0);
    assert.ok(!Object.hasOwn(next, 'diagnostics'));
  }
  const source = 'for(int i=0;i<2;i++){Frame:{if(outer(input)){step("P");if(mode!=0)break Frame;continue;}fallback();}tail();}';
  assert.equal(fold(source).framesRemoved, 1, 'a bare guarded break has the same destination');
  const next = compose(source, {parameterNames: ['input', 'mode']});
  assert.equal(next.counts.guardedAbruptFrames, 1);
  assert.equal(compose(next.source, {parameterNames: ['input', 'mode']}).rewrites, 0);
  const scoped = 'Frame:{int prefix=1;if(outer(input)){step(prefix);if(mode!=0){break Frame;}return value();}fallback();}tail();';
  assert.equal(fold(scoped, {retainDiagnostics: true}).diagnostics.frameScopeRetained, true);
  const positioned = 'if(other())Frame:{step("prefix");if(outer(input)){step("P");if(mode!=0){break Frame;}return value();}fallback();}else tail();';
  assert.equal(fold(positioned, {retainDiagnostics: true}).diagnostics.frameScopeRetained, true);
  assert.equal(fold(source, {retainDiagnostics: true}).diagnostics.frameScopeRetained, false);
  const multiline = 'while(more()){\n  Frame:{\n    if(entity!=null){\n      step();\n      if(flag!=0){\n        break Frame;\n      }\n      continue;\n    }\n    fallback();\n  }\n  tail();\n}';
  assert.equal(fold(multiline).source, 'while(more()){\n  if(entity!=null){\n    step();\n    if (flag==0) {\n      continue;\n    }\n  } else {\n    fallback();\n  }\n  tail();\n}');
});

test('ambiguous targets, intervening protected scopes and incomplete statements refuse recovery', () => {
  const original = 'for(int i=0;i<2;i++){Frame:{if(outer(input)){step("P");if(mode!=0){break Frame;}continue;}fallback();}tail();}';
  for (const source of [
    original.replace('break Frame;', 'break Missing;'),
    original.replace('continue;', 'continue Missing;'),
    original.replace('continue;', 'continue Frame;'),
    original.replace('step("P");', 'if(other())break Frame;step("P");'),
    original.replace('continue;', 'break Frame;'),
    original.replace('if(mode!=0){break Frame;}', 'if(mode!=0){try{break Frame;}finally{cleanup();}}'),
    original.replace('if(mode!=0){break Frame;}', 'if(mode!=0){synchronized(lock){break Frame;}}'),
    original.replace('if(mode!=0){break Frame;}', 'if(mode!=0){step("guard-effect");break Frame;}'),
    original.replace('if(mode!=0){break Frame;}', 'if(mode!=0){break Frame;}else{step("alternate");}'),
    original.replace('continue;', '{continue;}'),
    original.replace('fallback();', ''),
    original.replace('step("P");', 'step("P")'),
    original.replace('step("P");', '1+2;'),
    original.replace('fallback();', 'fallback()'),
    original.replace('continue;', 'return value()'),
    original.replace('continue;', 'throw specific'),
    original.replace('continue;', 'break'),
    original + ' // comment\n',
    original + '\\u000a',
    original + 'Runnable task=()->step("task");',
    original + 'class Local {void run(){step("local");}}',
    original + 'Frame:{step("separate");}',
  ]) assert.deepEqual(fold(source), {source, framesRemoved: 0, jumpsRemoved: 0}, source);
});

test('diagnostics identify the consumed frame and transfer without claiming a flag value', () => {
  const source = 'Frame:{if(outer(input)){step("P");if(Holder.flag!=0){break Frame;}throw makeFailure();}fallback();}tail();';
  const next = fold(source, {retainDiagnostics: true});
  assert.equal(next.framesRemoved, 1);
  assert.equal(next.diagnostics.abruptKind, 'ThrowStatement');
  assert.equal(next.diagnostics.predicate, 'Holder.flag==0');
  assert.equal(source.slice(next.diagnostics.labelRange.start, next.diagnostics.labelRange.end), 'Frame:');
  assert.equal(source.slice(next.diagnostics.jumpRange.start, next.diagnostics.jumpRange.end), 'break Frame;');
  assert.deepEqual(fold(source, {retainDiagnostics: 'yes'}), {source, framesRemoved: 0, jumpsRemoved: 0});
});

test('a guarded suffix retains every statement and nested scope before the abrupt exit', () => {
  const source = 'while(more()){\n  Frame:{\n    if(entity!=null){\n      step();\n      if(flag!=0){\n        break Frame;\n      }\n      int value=3;\n      try{\n        step(value);\n      }finally{\n        cleanup();\n      }\n      continue;\n    }\n    fallback();\n  }\n  tail();\n}';
  const result = fold(source, {retainDiagnostics: true});
  assert.equal(result.framesRemoved, 1);
  assert.equal(result.diagnostics.guardedSuffixStatements, 3);
  assert.equal(result.source, 'while(more()){\n  if(entity!=null){\n    step();\n    if (flag==0) {\n      int value=3;\n      try{\n        step(value);\n      }finally{\n        cleanup();\n      }\n      continue;\n    }\n  } else {\n    fallback();\n  }\n  tail();\n}');
  assert.equal(fold(result.source).framesRemoved, 0);
  for (const refused of [
    source.replace('if(flag!=0){', 'try{if(flag!=0){').replace('int value=3;', '}finally{cleanup();}int value=3;'),
    source.replace('int value=3;', 'int value=3;if(other())break Frame;'),
    source.replace('continue;', 'step(value);'),
    source.replace('int value=3;', 'int value=3'),
  ]) assert.deepEqual(fold(refused), {source: refused, framesRemoved: 0, jumpsRemoved: 0}, refused);
});

test('shared fallback exits keep their exact labeled destination and its scope', () => {
  const source = 'while(more()){\n  Frame:{\n    if(entity!=null){\n      step();\n      if(flag!=0){\n        break Frame;\n      }\n      draw();\n      continue;\n    }\n    while(fallbackMore()){\n      fallback();\n      if(done())break Frame;\n    }\n    afterFallback();\n  }\n  tail();\n}';
  const next = fold(source, {retainDiagnostics: true});
  assert.equal(next.framesRemoved, 0);
  assert.equal(next.jumpsRemoved, 1);
  assert.equal(next.diagnostics.labelRetained, true);
  assert.equal(next.diagnostics.frameScopeRetained, true);
  assert.equal(next.source, 'while(more()){\n  Frame:{\n    if(entity!=null){\n      step();\n      if (flag==0) {\n        draw();\n        continue;\n      }\n    } else {\n      while(fallbackMore()){\n        fallback();\n        if(done())break Frame;\n      }\n      afterFallback();\n    }\n  }\n  tail();\n}');
  assert.equal(fold(next.source).jumpsRemoved, 0);
  const composed = compose(source);
  assert.equal(composed.counts.guardedAbruptJumps, 1);
  assert.equal(composed.counts.guardedAbruptFrames, 0);
  assert.equal(compose(composed.source).rewrites, 0);
  for (const bad of [
    source.replace('if(entity!=null){', 'if(prefixExit())break Frame;\n    if(entity!=null){'),
    source.replace('draw();', 'if(suffixExit())break Frame;draw();'),
    source.replace('step();', 'if(armExit())break Frame;step();'),
    source.replace('if(flag!=0){', 'try{if(flag!=0){').replace('draw();', '}finally{cleanup();}draw();'),
    source.replace('if(done())break Frame;', 'if(done())continue Frame;'),
  ]) assert.deepEqual(fold(bad), {source: bad, framesRemoved: 0, jumpsRemoved: 0});
});

test('native guarded abrupt exits preserve effect order, targets, NaNs, unboxing and cleanup', () => {
  const variants = [
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(mode!=0){break Frame;}return value();}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(metric>0){break Frame;}return value();}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(metric==0){break Frame;}return value();}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(metric!=0){break Frame;}return value();}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(boxed){break Frame;}return value();}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}throw makeFailure();}fallback();}tail();',
    'for(int index=0;index<2;index++){Frame:{if(outer(input)){step("P"+index);if(predicate(mode)){break Frame;}continue;}fallback();}tail();}',
    'Outer:for(int index=0;index<2;index++){for(int inner=0;inner<2;inner++){Frame:{if(outer(input)){step("P"+index+inner);if(predicate(mode)){break Frame;}continue Outer;}fallback();}tail();}}',
    'for(int index=0;index<2;index++){Frame:{if(outer(input)){step("P"+index);if(predicate(mode)){break Frame;}break;}fallback();}tail();}',
    'Outer:{Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}break Outer;}fallback();}tail();}step("outside");',
    'switch(input){case 0:Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}break;}fallback();}tail();default:step("default");}',
    'try{Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}fallback();}tail();}finally{cleanup();}',
    'try{Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}throw makeFailure();}fallback();}tail();}catch(RuntimeException failure){step(failure==specific?"caught-specific":"caught-other");}finally{cleanup();}',
    'synchronized(lock){Frame:{if(outer(input)){step("P"+Thread.holdsLock(lock));if(predicate(mode)){break Frame;}return value();}fallback();}tail();}',
    'Frame:{if(outer(input)){try{step("P");}finally{cleanup();}if(predicate(mode)){break Frame;}return value();}fallback();}tail();',
    'int prefix=13;Frame:{step("prefix");if(outer(input)){int local=prefix+1;step("P"+local);if(predicate(mode)){break Frame;}return local;}int local=prefix+2;step("fallback"+local);}tail();',
    'int guard=mode;Frame:{if(outer(input)){guard=input;step("P");if(guard!=0){break Frame;}return guard;}fallback();}tail();',
    'Frame:{if(outer(input)){step("/* string */");if(((predicate(mode)==true))){break Frame;}return value();}fallback();}tail();',
    'for(int index=0;index<2;index++){try{Frame:{if(outer(input)){step("P"+index);if(predicate(mode)){break Frame;}continue;}fallback();}tail();}finally{cleanup();if(input==1)break;}}',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)&&boxed){break Frame;}return value();}fallback();}tail();',
    'Frame:{int nested=13;if(outer(input)){step("P"+nested);if(predicate(mode)){break Frame;}return nested;}fallback();}step("after"+nested);',
    'if(input>=0)Frame:{step("prefix");if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}fallback();}else step("outside-else");tail();',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}step("suffix");return value();}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}int nested=19;step("suffix"+nested);return nested;}fallback();}step("after"+nested);',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}try{step("suffix");}finally{cleanup();}return value();}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}synchronized(lock){step("held"+Thread.holdsLock(lock));}return value();}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}try{step("suffix");}catch(IllegalArgumentException caught){step("caught"+(caught==specific));}return value();}fallback();}tail();',
    'for(int index=0;index<2;index++){Frame:{if(outer(input)){step("P"+index);if(predicate(mode)){break Frame;}try{step("suffix");}finally{cleanup();if(input==1)break;}continue;}fallback();}tail();}',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}switch(input){case 0:step("case0");break;case 1:step("case1");default:step("default");}return value();}fallback();}tail();',
    'Outer:for(int index=0;index<2;index++){for(int inner=0;inner<2;inner++){Frame:{if(outer(input)){step("P"+index+inner);if(predicate(mode)){break Frame;}step("suffix");if(input==1)continue Outer;continue;}fallback();}tail();}}',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}int result=17;if(metric<0)result++;step("result"+result);return result;}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(predicate(mode))break Frame;{int nested=19;step("inner"+nested);}step("field"+nested);return value();}fallback();}tail();',
    'if(input>=0)Frame:{step("prefix");if(outer(input)){step("P");if(predicate(mode)){break Frame;}int nested=19;step("suffix"+nested);return nested;}int nested=23;step("fallback"+nested);}else step("outside-else");step("after"+nested);',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}step("suffix");return value();}if(input<0){step("early-fallback");break Frame;}fallback();}tail();',
    'Frame:{int nested=13;if(outer(input)){step("P"+nested);if(predicate(mode)){break Frame;}step("suffix");return nested;}try{fallback();if(input!=0)break Frame;}finally{cleanup();}step("after-fallback");}step("after"+nested);',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}synchronized(lock){step("fallback-held"+Thread.holdsLock(lock));if(input!=0)break Frame;}step("after-fallback");}tail();',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}for(int index=0;index<2;index++){step("fallback"+index);if(index==1)break Frame;}step("after-fallback");}tail();',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}switch(input){case -1:step("case-1");break Frame;case 7:step("case7");default:step("default");}step("after-fallback");}tail();',
    'if(input>=0)Frame:{step("prefix");if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}for(int index=0;index<2;index++){fallback();if(index==1)break Frame;}step("after-fallback");}else step("outside-else");tail();',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}try{step("suffix");}finally{cleanup();}return value();}try{fallback();if(input!=0)break Frame;}finally{cleanup();}step("after-fallback");}tail();',
    'Outer:for(int index=0;index<2;index++){Frame:{if(outer(input)){step("P"+index);if(predicate(mode)){break Frame;}step("suffix");continue Outer;}for(int inner=0;inner<2;inner++){fallback();if(inner==1)break Frame;}step("after-fallback");}tail();}',
    'try{Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}step("suffix");throw makeFailure();}try{fallback();if(input!=0)break Frame;}finally{cleanup();}step("after-fallback");}tail();}catch(RuntimeException caught){step("caught"+(caught==specific));}finally{cleanup();}',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}if(input<0){step("negative");break Frame;}if(input>1){step("positive");break Frame;}fallback();}tail();',
    'Frame:{if(outer(input)){step("P");if(boxed){break Frame;}step("suffix");return value();}for(int index=0;index<2;index++){fallback();if(index==1)break Frame;}step("after-fallback");}tail();',
    'Outside:{Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}for(int index=0;index<2;index++){fallback();if(input<0)break Outside;if(index==1)break Frame;}step("after-fallback");}tail();}step("outside");',
    'Frame:{if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}try{fallback();return 17;}finally{if(input<0)break Frame;cleanup();}}tail();',
    'Frame:{step("prefix");if(outer(input)){step("P");if(predicate(mode)){break Frame;}return value();}try{fallback();}catch(IllegalArgumentException caught){step("caught"+(caught==specific));break Frame;}step("after-fallback");}tail();',
  ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-abrupt-native-'));
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
      assert.ok(next.jumps > 0, index + ': ' + source);
      let cleaned = next.source;
      for (;;) { const result = clean(cleaned); if (result.source === cleaned) break; cleaned = result.source; }
      cleaned = compose(cleaned, {parameterNames: ['mode', 'input', 'metric', 'boxed']}).source;
      for (const [name, body] of [['original', source], ['rebuilt', next.source], ['composed', cleaned]])
        methods.push(`static int ${name}${index}(int mode,int input,double metric,Boolean boxed){${body}return 99;}`);
    });
    const java = `public class GuardedAbruptExits {
      static StringBuilder trace;static int failures,effects,cleanups,mutableGuard,nested=77;static Object lock;
      static final RuntimeException specific=new IllegalArgumentException();static final Error fatal=new AssertionError();
      static void step(String s){trace.append(s).append('/');effects++;mutableGuard++;if(failures==1&&effects==1||failures==2&&effects==2)throw specific;}
      static void fallback(){step("fallback");}static void tail(){step("tail");}
      static boolean outer(int input){trace.append("outer/");return input==0||input==1;}
      static boolean predicate(int mode){trace.append("guard/");if(failures==4)throw specific;return mode!=0&&mutableGuard>0;}
      static int value(){step("value");return mutableGuard;}
      static RuntimeException makeFailure(){step("failure");return specific;}
      static void cleanup(){trace.append("cleanup/");cleanups++;if(failures==3)throw fatal;}
      ${methods.join('\n')}
      interface Call{int run();}
      static String invoke(Call call,boolean nullLock){trace=new StringBuilder();effects=0;cleanups=0;mutableGuard=0;lock=nullLock?null:new Object();String result;try{result="ok="+call.run();}catch(Throwable e){result=e==specific?"specific":e==fatal?"fatal":e.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("lock retained");return result+":"+effects+":"+cleanups+":"+mutableGuard+":"+trace;}
      static void oracle(Call call,String expected){String actual=invoke(call,false);if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);}
      public static void main(String[]args){int comparisons=0;
        oracle(()->composed0(0,0,0,false),"ok=2:2:0:2:outer/P/guard/value/");
        oracle(()->composed0(7,0,0,false),"ok=99:2:0:2:outer/P/guard/tail/");
        oracle(()->composed0(0,7,0,false),"ok=99:2:0:2:outer/fallback/tail/");
        oracle(()->composed2(0,0,Double.NaN,false),"ok=2:2:0:2:outer/P/value/");
        oracle(()->composed4(0,0,Double.NaN,false),"ok=99:2:0:2:outer/P/tail/");
        oracle(()->composed5(0,0,0,null),"java.lang.NullPointerException:1:0:1:outer/P/");
        oracle(()->composed6(0,0,0,false),"specific:2:0:2:outer/P/guard/failure/");
        oracle(()->composed7(0,0,0,false),"ok=99:2:0:2:outer/P0/guard/outer/P1/guard/");
        oracle(()->composed9(0,0,0,false),"ok=99:1:0:1:outer/P0/guard/");
        oracle(()->composed12(0,0,0,false),"ok=2:2:1:2:outer/P/guard/value/cleanup/");
        oracle(()->composed14(0,0,0,false),"ok=2:2:0:2:outer/Ptrue/guard/value/");
        oracle(()->composed16(0,0,0,false),"ok=14:2:0:2:prefix/outer/P14/guard/");
        oracle(()->composed21(7,0,0,false),"ok=99:2:0:2:outer/P13/guard/after77/");
        oracle(()->composed21(0,0,0,false),"ok=13:1:0:1:outer/P13/guard/");
        oracle(()->composed22(0,-1,0,false),"ok=99:2:0:2:outside-else/tail/");
        oracle(()->composed23(0,0,0,false),"ok=3:3:0:3:outer/P/guard/suffix/value/");
        oracle(()->composed23(7,0,0,false),"ok=99:2:0:2:outer/P/guard/tail/");
        oracle(()->composed23(0,7,0,false),"ok=99:2:0:2:outer/fallback/tail/");
        oracle(()->composed24(0,0,0,false),"ok=19:2:0:2:outer/P/guard/suffix19/");
        oracle(()->composed24(7,0,0,false),"ok=99:2:0:2:outer/P/guard/after77/");
        oracle(()->composed25(0,0,0,false),"ok=3:3:1:3:outer/P/guard/suffix/cleanup/value/");
        oracle(()->composed25(7,0,0,false),"ok=99:2:0:2:outer/P/guard/tail/");
        oracle(()->composed26(0,0,0,false),"ok=3:3:0:3:outer/P/guard/heldtrue/value/");
        oracle(()->composed28(0,1,0,false),"ok=99:2:1:2:outer/P0/guard/suffix/cleanup/");
        oracle(()->composed29(0,0,0,false),"ok=3:3:0:3:outer/P/guard/case0/value/");
        oracle(()->composed29(0,1,0,false),"ok=4:4:0:4:outer/P/guard/case1/default/value/");
        oracle(()->composed31(0,0,-1,false),"ok=18:2:0:2:outer/P/guard/result18/");
        oracle(()->composed32(0,0,0,false),"ok=4:4:0:4:outer/P/guard/inner19/field77/value/");
        oracle(()->composed33(7,0,0,false),"ok=99:3:0:3:prefix/outer/P/guard/after77/");
        oracle(()->composed33(0,7,0,false),"ok=99:3:0:3:prefix/outer/fallback23/after77/");
        failures=2;oracle(()->composed27(0,0,0,false),"ok=4:4:0:4:outer/P/guard/suffix/caughttrue/value/");failures=0;
        oracle(()->composed34(7,0,0,false),"ok=99:2:0:2:outer/P/guard/tail/");
        oracle(()->composed34(0,-1,0,false),"ok=99:2:0:2:outer/early-fallback/tail/");
        oracle(()->composed35(0,7,0,false),"ok=99:2:1:2:outer/fallback/cleanup/after77/");
        oracle(()->composed35(7,0,0,false),"ok=99:2:0:2:outer/P13/guard/after77/");
        oracle(()->composed36(0,7,0,false),"ok=99:2:0:2:outer/fallback-heldtrue/tail/");
        oracle(()->composed37(0,7,0,false),"ok=99:3:0:3:outer/fallback0/fallback1/tail/");
        oracle(()->composed38(0,-1,0,false),"ok=99:2:0:2:outer/case-1/tail/");
        oracle(()->composed38(0,7,0,false),"ok=99:4:0:4:outer/case7/default/after-fallback/tail/");
        oracle(()->composed39(0,-1,0,false),"ok=99:2:0:2:outside-else/tail/");
        oracle(()->composed40(0,0,0,false),"ok=3:3:1:3:outer/P/guard/suffix/cleanup/value/");
        oracle(()->composed40(7,0,0,false),"ok=99:2:0:2:outer/P/guard/tail/");
        oracle(()->composed42(0,7,0,false),"ok=99:2:2:2:outer/fallback/cleanup/tail/cleanup/");
        oracle(()->composed43(0,7,0,false),"ok=99:2:0:2:outer/positive/tail/");
        oracle(()->composed45(0,-1,0,false),"ok=99:2:0:2:outer/fallback/outside/");
        oracle(()->composed46(0,-1,0,false),"ok=99:2:0:2:outer/fallback/tail/");
        oracle(()->composed46(0,7,0,false),"ok=17:1:1:1:outer/fallback/cleanup/");
        failures=2;oracle(()->composed47(0,7,0,false),"ok=99:4:0:4:prefix/outer/fallback/caughttrue/tail/");failures=0;
        for(failures=0;failures<5;failures++)for(int mode:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(double metric:new double[]{Double.NaN,Double.NEGATIVE_INFINITY,-1,-0.0,0.0,1,Double.POSITIVE_INFINITY})for(Boolean boxed:new Boolean[]{false,true,null})for(boolean nullLock:new boolean[]{false,true}){
          ${variants.flatMap((_, i) => ['rebuilt', 'composed'].map(name => `{String expected=invoke(()->original${i}(mode,input,metric,boxed),nullLock),actual=invoke(()->${name}${i}(mode,input,metric,boxed),nullLock);if(!expected.equals(actual))throw new AssertionError("${name}${i}:"+failures+":"+mode+":"+input+":"+metric+":"+boxed+":"+nullLock+":"+expected+" != "+actual);comparisons++;}`)).join('\n')}
        }if(comparisons!=725760)throw new AssertionError(comparisons);System.out.println("guarded-abrupt-native:"+comparisons+",oracles:48");
      }
    }`;
    const file = path.join(directory, 'GuardedAbruptExits.java');
    fs.writeFileSync(file, java);
    run('javac', ['--release', '8', '-d', directory, file]);
    console.log(run('java', ['-cp', directory, 'GuardedAbruptExits']).trim());
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
