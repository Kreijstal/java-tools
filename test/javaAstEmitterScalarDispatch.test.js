'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const {spawnSync} = require('child_process');
const {recoverScalarLabelDispatches: fold, simplifyControlFrames} = require('../src/decompiler/javaAstEmitter');

function ladder(actions = ['step("A");', 'step("B");', 'step("C");'], external = false) {
  return `int selector = input; int guard = mode;
${external ? 'Exit: { step("entry");' : ''}
L0: {
  L1: {
    L2: {
      if (selector == 1 && guard == 0) {
        ${actions[0]}
        if (guard == 0) { break ${external ? 'Exit' : 'L0'}; }
      } else if (!(selector == 2 && guard == 0)) {
        if (selector == 3) { break L2; }
        ${external ? 'if(selector == 4) { break L0; }' : ''}
        break ${external ? 'Exit' : 'L1'};
      }
      ${actions[1]}
      if (guard == 0) { break ${external ? 'Exit' : 'L0'}; }
    }
    ${actions[2]}
    if (guard == 0) { break ${external ? 'Exit' : 'L0'}; }
  }
  ${external ? '' : 'step("D");'}
}
${external ? 'step("common"); }' : ''}
step("tail");`;
}
function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(n => path.join(directory, n));
  const descriptors = files.map(f => fs.openSync(f, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...descriptors], timeout: 15000,
      env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'}});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally {descriptors.forEach(fd => fs.closeSync(fd));}
}

test('scalar dispatch recovery keeps actions, guards and physical fallthrough order', () => {
  for (const external of [false, true]) {
    const source = ladder(undefined, external), next = fold(source);
    assert.equal(next.dispatchesRecovered, 1);
    assert.match(next.source, /(?:L0|Exit): switch \(\(guard == 0/);
    assert.match(next.source, /case 1:[\s\S]*step\("A"\)[\s\S]*case 2:[\s\S]*step\("B"\)[\s\S]*case 3:[\s\S]*step\("C"\)/);
    assert.ok(!next.source.includes('L1:') && !next.source.includes('L2:'));
    assert.equal(fold(next.source).dispatchesRecovered, 0);
    const cleaned = simplifyControlFrames(next.source);
    assert.equal(fold(cleaned.source).dispatchesRecovered, 0);
    assert.ok(!Object.hasOwn(next, 'diagnostics'));
  }
});

test('dispatch diagnostics locate old classifier conditions without action guards', () => {
  const source = ladder(), next = fold(source, {retainDiagnostics: true});
  assert.equal(next.dispatchesRecovered, 1);
  assert.deepEqual(next.diagnostics.constants.slice().sort(), [1, 2, 3]);
  assert.equal(next.diagnostics.primary, 'selector');
  assert.equal(next.diagnostics.guard, 'guard');
  assert.equal(next.diagnostics.labelsConsumed, 3);
  assert.deepEqual(next.diagnostics.conditionRanges.map(r => source.slice(r.start, r.end)),
    ['selector == 3', '!(selector == 2 && guard == 0)', 'selector == 1 && guard == 0']);
  assert.match(source.slice(next.diagnostics.start, next.diagnostics.end), /^L0: \{/);
  assert.equal(next.diagnostics.selectorExpression, '(guard == 0 || selector == 3) ? selector : -1');
});

test('unproven classifier types, scopes, effects and jump destinations stay untouched', () => {
  const base = ladder();
  const refused = [
    base.replace('int selector = input;', ''),
    base.replace('int selector', 'Integer selector'),
    base.replace('int selector', 'long selector'),
    base.replace('int selector', 'float selector'),
    base.replace('int selector', '@Mark int selector'),
    base.replace('int selector', 'volatile int selector'),
    base.replace('selector == 3', 'this.selector == 3'),
    base.replace('selector == 3', 'select() == 3'),
    base.replace('selector == 3', 'selector++ == 3'),
    base.replace('selector == 3', 'selector + 0 == 3'),
    base.replace('selector == 3', 'selector == 03'),
    base.replace('selector == 3', 'selector == 3L'),
    base.replace('selector == 3', 'selector == 0x3'),
    base.replace('selector == 3', 'selector == 2147483648'),
    base.replace('selector == 3', 'selector == 3 && guard == 1'),
    base.replace('int selector = input;', '{int selector = input;}'),
    base + '\n{int selector=0;}',
    base.replace('step("C");', 'int local = 1; step("C");'),
    base.replace('step("C");', 'Label: int local = 1;'),
    base.replace('step("A");', 'break L2;'),
    base.replace('step("A");', 'step("A");if(guard==7)break L2;'),
    base.replace('if (selector == 3) { break L2; }', 'if(selector==3){if(guard==0)break L2;else break L0;}'),
    base.replace('step("A");', 'break;'),
    base.replace('break L2;', 'continue L2;'),
    base.replace('break L2;', 'break Missing;'),
    base.replace('step("A");', 'selector=3;')
      .replace('      step("B");', '      if(selector == 2){break L0;} step("B");'),
    base.replace('step("A");', 'Runnable task=()->step("X");'),
    base.replace('step("A");', 'class Local {void run(){step("X");}}'),
    base.replace('step("A");', 'step("A"); // retained comment\n'),
    base.replace('selector == 3', '\\u0073elector == 3'),
    base.replace('break L2;', 'break L2'),
    base.replace('step("A");', 'step("A")'),
    base.replace('step("A");', 'return'),
    base.replace('step("A");', 'throw failure'),
    base.replace('int selector = input;', 'int selector = input'),
    base.replace('step("A");', 'assert true'),
  ];
  for (const source of refused) assert.deepEqual(fold(source), {source, dispatchesRecovered: 0}, source);
  // A new switch would capture this formerly enclosing-loop break.
  const captured = 'while(more()) {\n' + base.replace('step("C");', 'break;') + '\n}';
  assert.equal(fold(captured).dispatchesRecovered, 0);
});

test('native scalar dispatch preserves all selectors, both flag modes, effects and cleanup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scalar-dispatch-'));
  try {
    const variants = [
      ladder(),
      ladder(undefined, true),
      ladder(['selector = 3; guard = 7; step("A");', 'step("B");', 'step("C");']),
      ladder(['step("A");', 'guard = 7; step("B");', 'step("C");']),
      ladder(['step("A");', 'step("B");', 'selector = 1; guard = 0; step("C");']),
      ladder(['{int local=selector;step("A"+local);}', '{int local=guard;step("B"+local);}', '{int local=9;step("C"+local);}']),
      ladder(['try {step("A");} finally {cleanup();}', 'try {step("B");} catch(IllegalArgumentException failure){step("caught");}', 'step("C");']),
      ladder(['synchronized(lock){step("A"+Thread.holdsLock(lock));}', 'synchronized(lock){step("B"+Thread.holdsLock(lock));}', 'step("C");']),
      ladder(['for(int i=0;i<3;i++){step("A"+i);if(i==1)break;}', 'while(once()){step("B");break;}', 'do{step("C");}while(false);']),
      ladder(['switch(selector){case 1:step("A");break;default:step("Z");}', 'step("B");', 'step("C");']),
      ladder(['try {step("A");} finally {if(effectMode==4)break L0;}', 'step("B");', 'step("C");']),
      ladder(['step("A"); if(effectMode==4)return;', 'step("B");', 'step("C");']),
      ladder(['step("A"); if(effectMode==4)throw fatal;', 'step("B");', 'step("C");']),
      'try {\n' + ladder() + '\n} finally {cleanup();}',
      'synchronized(lock){\n' + ladder() + '\n}',
      'for(int index=0;index<2;index++){\n' + ladder(['step("A");if(effectMode==4)continue;', 'step("B");', 'step("C");']) + '\n}',
      'Again:for(int index=0;index<2;index++){\n' + ladder(['step("A");if(effectMode==4)continue Again;', 'step("B");', 'step("C");']) + '\n}',
      ladder().replace('int selector = input;', 'int selector; selector=input;'),
      ladder().replace('int selector = input;', 'final int selector = 2;'),
      ladder().replace('selector == 1', '!(selector != 1)').replace('selector == 3', '(3 == selector)'),
      ladder().replace('selector == 1', 'selector == -2147483648').replace('selector == 2', 'selector == 2147483647'),
      ladder().replaceAll('guard == 0', 'guard == -5'),
      ladder(undefined, true).replace('if(selector == 4) { break L0; }', ''),
      ladder().replaceAll(' && guard == 0', ''),
      ladder(['result=1;', 'result=2;', 'result=3;'])
        .replace('int selector = input;', 'int result; int selector = input;')
        .replace('step("D");', 'result=4;').replace('step("tail");', 'step("R"+result);'),
      ladder().replace('selector == 3', 'selector == 3 || selector == 3'),
    ];
    const methods=[];
    variants.forEach((body, index) => {
      const next=fold(body); assert.equal(next.dispatchesRecovered, 1, index);
      assert.equal(fold(next.source).dispatchesRecovered, 0, index);
      let cleaned=next.source; for(;;){const result=simplifyControlFrames(cleaned);if(result.source===cleaned)break;cleaned=result.source;}
      assert.equal(fold(cleaned).dispatchesRecovered,0,index);
      for(const [name, text] of [['original', body], ['folded', next.source], ['rebuilt', cleaned]])
        methods.push(`static void ${name}${index}(int input,int mode){${text}}`);
    });
    const java=`public class ScalarDispatch {
      static int effectMode,effects,cleanups; static StringBuilder trace;static Object lock;
      static final RuntimeException specific=new IllegalArgumentException();static final Error fatal=new AssertionError();
      static void step(String value){trace.append(value).append('/');effects++;if(effectMode==1&&effects==1||effectMode==2&&effects==2)throw specific;}
      static void cleanup(){trace.append("cleanup/");cleanups++;if(effectMode==3)throw fatal;}
      static boolean once(){return true;}
      ${methods.join('\n')}
      interface Call{void call();}
      static String invoke(Call call,boolean nullLock){trace=new StringBuilder();effects=0;cleanups=0;lock=nullLock?null:new Object();String result;
        try{call.call();result="ok";}catch(Throwable error){result=error==specific?"specific":error==fatal?"fatal":error.getClass().getName();}
        if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor retained");return result+":"+effects+":"+cleanups+":"+trace;
      }
      static void oracle(Call call,String expected){String actual=invoke(call,false);if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);}
      public static void main(String[]args){int comparisons=0;
        oracle(()->rebuilt0(1,0),"ok:2:0:A/tail/");
        oracle(()->rebuilt0(2,0),"ok:2:0:B/tail/");
        oracle(()->rebuilt0(3,0),"ok:2:0:C/tail/");
        oracle(()->rebuilt0(3,7),"ok:3:0:C/D/tail/");
        oracle(()->rebuilt0(1,7),"ok:2:0:D/tail/");
        oracle(()->rebuilt1(4,7),"ok:3:0:entry/common/tail/");
        oracle(()->rebuilt1(99,7),"ok:2:0:entry/tail/");
        oracle(()->rebuilt2(1,0),"ok:5:0:A/B/C/D/tail/");
        oracle(()->rebuilt4(3,7),"ok:2:0:C/tail/");
        effectMode=3;oracle(()->rebuilt13(2,0),"fatal:2:1:B/tail/cleanup/");effectMode=0;
        for(effectMode=0;effectMode<6;effectMode++)for(int input:new int[]{Integer.MIN_VALUE,-99,-5,-2,-1,0,1,2,3,4,5,6,99,Integer.MAX_VALUE})for(int mode:new int[]{Integer.MIN_VALUE,-5,-1,0,1,7,Integer.MAX_VALUE})for(boolean nullLock:new boolean[]{false,true}){
          ${variants.flatMap((_,index)=>['folded','rebuilt'].map(name=>`{String expected=invoke(()->original${index}(input,mode),nullLock),actual=invoke(()->${name}${index}(input,mode),nullLock);if(!expected.equals(actual))throw new AssertionError("${name}${index}:"+effectMode+":"+input+":"+mode+":"+nullLock+":"+expected+" != "+actual);comparisons++;}`)).join('\n')}
        }
        if(comparisons!=61152)throw new AssertionError(comparisons);System.out.println("scalar-dispatch-native:"+comparisons);
      }
    }`;
    const file=path.join(directory,'ScalarDispatch.java');fs.writeFileSync(file,java);
    run('javac',['--release','8','-d',directory,file],directory);
    assert.equal(run('java',['-cp',directory,'ScalarDispatch'],directory).trim(),'scalar-dispatch-native:61152');
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
