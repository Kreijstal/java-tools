'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {foldGuardedLoopContinuations: fold} = require('../src/decompiler/javaAstEmitter');

test('nested backedges permit guarded loops without consuming any transfer or label', () => {
  const source = 'int index=0; Next:while(true){if(index<limit){while(true){index++;continue Next;}}finish();return;}';
  const result = fold(source, {parameterNames: ['limit'], retainDiagnostics: true});
  assert.equal(result.loopsRecovered, 1);
  assert.match(result.source, /Next: while \(index<limit\)/);
  assert.match(result.source, /continue Next;/);
  assert.equal(result.diagnostics.predicate, 'index<limit');
  assert.equal(source.slice(result.diagnostics.armRange.start, result.diagnostics.armRange.end), '{while(true){index++;continue Next;}}');
  assert.equal(source.slice(result.diagnostics.suffixRange.start, result.diagnostics.suffixRange.end), 'finish();return;');
  assert.equal(fold(result.source, {parameterNames: ['limit']}).loopsRecovered, 0);
  const scalar = 'if(pick) Next:while(true){if(more()){while(true){continue Next;}}finish();return;}else other();';
  assert.match(fold(scalar, {parameterNames: ['pick']}).source, /if\(pick\) \{\s*Next: while/);
  assert.match(fold(scalar, {parameterNames: ['pick']}).source, /\}\s*else other\(\);/);
});

test('continuation declarations retain their old scope and protected groups stay intact', () => {
  const source = 'Stop:{int count=0;Next:while(true){if(more()){try{while(true){if(count++>2)break Stop;continue Next;}}finally{cleanup();}}int value=count;return value;}}int value=9;use(value);';
  const result = fold(source, {retainDiagnostics: true});
  assert.equal(result.loopsRecovered, 1);
  assert.equal(result.diagnostics.retainedTailScope, true);
  assert.match(result.source, /try\{while\(true\)\{if\(count\+\+>2\)break Stop;continue Next;\}\}finally\{cleanup\(\);\}/);
  assert.match(result.source, /\{\s*int value=count;return value;\s*\}/);
  assert.match(result.source, /\}int value=9;use\(value\);/);
});

test('consumed breaks, repeating continuations, constants and unsupported syntax refuse rotation', () => {
  const prefix = 'int index=0; Next:while(true){if(index<limit){', suffix = '}finish();return;}';
  for (const source of [
    prefix + 'while(true){if(index>0)break;index++;continue Next;}' + suffix,
    prefix + 'Inner:while(true){if(index>0)break Inner;index++;continue Next;}' + suffix,
    prefix + 'Inner:while(true){switch(index){case 0:break Inner;default:index++;continue Next;}}' + suffix,
    prefix + 'try{while(true){index++;continue Next;}}catch(Exception error){finish();}' + suffix,
    prefix + 'while(true){try{index++;continue Next;}finally{if(stop())break;}}' + suffix,
    prefix + 'break Next;' + suffix,
    prefix + 'try{continue Next;}finally{if(stop())break Next;}' + suffix,
    prefix + 'index++;' + suffix,
    prefix + 'continue Next;}finish();continue Next;}',
    prefix + 'continue Next;}finish();break Next;}',
    prefix + 'continue Next;}finish();}',
    prefix + 'continue Next;}while(true){if(stop())break;}finish();}',
    'Next:while(true){if(true){continue Next;}finish();return;}',
    'final boolean guard=true;Next:while(true){if(guard){continue Next;}finish();return;}',
    'Next:while(true){if(Holder.CONSTANT){continue Next;}finish();return;}',
    prefix + 'continue Missing;' + suffix,
    prefix + 'continue Next;' + suffix + 'Next:{finish();}',
    prefix + 'continue Next;' + suffix + ' // trivia\n',
    prefix + 'continue Next;' + suffix + '\\u000a',
    prefix + 'continue Next;' + suffix + 'Runnable work=()->finish();',
    prefix + 'continue Next;' + suffix + 'class Local{void work(){finish();}}',
    prefix + '1+2;continue Next;' + suffix,
    prefix + 'finish() continue Next;' + suffix,
    prefix + 'continue Next;}finish() return;}',
    'Next:while(true){prefix();if(more()){continue Next;}return;}',
    'Next:while(true){if(more()){continue Next;}else other();return;}',
  ]) assert.equal(fold(source, {parameterNames: ['limit']}).source, source, source);
  const source = prefix + 'continue Next;' + suffix;
  for (const options of [{parameterNames: ['limit', 'limit']}, {parameterNames: ['bad-name']}, {retainDiagnostics: 'yes'}])
    assert.deepEqual(fold(source, options), {source, loopsRecovered: 0});
});

test('guarded loop recovery matches native traces and an independent loop oracle', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-loop-native-'));
  const run = (command, args) => {
    const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
    assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout;
  };
  try {
    const inner = 'while(true){step("B",mode,trace);index++;if(mode==4)return done(index,polls,trace);if(mode==5)break Stop;if(mode==6)continue Rounds;continue Next;}';
    const variants = [
      {body: inner, kind: 0},
      {body: 'try{' + inner + '}finally{step("F",mode,trace);if(mode==7)return done(index,polls,trace);if(mode==8)continue Next;if(mode==9)break Rounds;}', kind: 1},
      {body: 'synchronized(lock){trace.append(Thread.holdsLock(lock)?"L":"bad");' + inner + '}', kind: 2},
      {body: 'try{' + inner + '}catch(Specific error){trace.append("C");return done(index,polls,trace);}catch(RuntimeException error){trace.append("G");return done(index,polls,trace);}', kind: 3},
      {body: 'try{synchronized(lock){trace.append(Thread.holdsLock(lock)?"L":"bad");' + inner + '}}finally{step("F",mode,trace);if(mode==7)return done(index,polls,trace);if(mode==8)continue Next;if(mode==9)break Rounds;}', kind: 4},
      {body: 'int mark=index;' + inner, kind: 0, tail: 'int mark=index;trace.append(mark);'},
    ];
    let methods = '', comparisons = 0;
    for (const [variant, {body, kind, tail = ''}] of variants.entries()) {
      const original = 'Rounds:for(int round=0;round<2;round++){Stop:{Next:while(true){if(++polls<=limit && gate){' + body + '}' + tail + 'step("S",mode,trace);return done(index,polls,trace);}}trace.append("E");}return done(index,polls,trace);';
      const result = fold(original, {parameterNames: ['limit', 'gate', 'mode', 'index', 'polls', 'lock', 'trace']});
      assert.equal(result.loopsRecovered, 1, original);
      assert.equal(fold(result.source, {parameterNames: ['limit', 'gate', 'mode', 'index', 'polls', 'lock', 'trace']}).loopsRecovered, 0);
      for (const [name, source] of Object.entries({original, rebuilt: result.source})) methods += `static String ${name}${variant}(int limit,Boolean gate,int mode,Object lock){int index=0,polls=0;StringBuilder trace=new StringBuilder();lastTrace=trace;lastLock=lock;try{${source}}finally{lastIndex=index;lastPolls=polls;}}\n`;
      methods += `static String compare${variant}(int limit,Boolean gate,int mode,Object lock){String expected=invoke(${variant},false,limit,gate,mode,lock),actual=invoke(${variant},true,limit,gate,mode,lock),oracle=oracle(${kind},${Boolean(tail)},limit,gate,mode,lock);if(!expected.equals(actual)||!expected.equals(oracle))throw new AssertionError(${variant}+":"+limit+":"+gate+":"+mode+":"+expected+":"+actual+":"+oracle);return actual;}\n`;
      comparisons += 31 * 3 * 12 * 2;
    }
    const source = `public class GuardedLoopBehavior {
      static class Specific extends RuntimeException{} static final Specific failure=new Specific();static final Error fatal=new Error();
      static StringBuilder lastTrace;static Object lastLock;static int lastIndex,lastPolls;
      static void step(String stage,int mode,StringBuilder trace){trace.append(stage);if(stage.equals("B")&&mode==1||stage.equals("S")&&mode==2||stage.equals("F")&&mode==3)throw failure;if(stage.equals("B")&&mode==10)throw fatal;}
      static String done(int index,int polls,StringBuilder trace){return index+":"+polls+":"+trace;}
      static String invoke(int variant,boolean rebuilt,int limit,Boolean gate,int mode,Object lock){
        String result;try{switch(variant){${variants.map((_,i)=>`case ${i}:result=rebuilt?rebuilt${i}(limit,gate,mode,lock):original${i}(limit,gate,mode,lock);break;`).join('')}default:throw new AssertionError();}}
        catch(Throwable error){result=(error==failure?"failure":error==fatal?"fatal":error.getClass().getName())+":"+lastIndex+":"+lastPolls+":"+lastTrace;}
        if(lastLock!=null&&Thread.holdsLock(lastLock))throw new AssertionError("monitor leaked");return result+"|"+lastTrace;
      }
      static String observe(String result,StringBuilder trace){return result+"|"+trace;}
      // Direct loop model: no labeled transfers or rewritten source are used.
      static String oracle(int kind,boolean scopedTail,int limit,Boolean gate,int mode,Object lock){
        int index=0,polls=0;StringBuilder trace=new StringBuilder();boolean finalizer=kind==1||kind==4,monitor=kind==2||kind==4;
        for(int round=0;round<2;round++){
          boolean escapedStop=false;
          while(true){
            polls++;
            if(polls<=limit&&gate==null)return observe("java.lang.NullPointerException:"+index+":"+polls+":"+trace,trace);
            if(polls>limit||!gate){if(scopedTail)trace.append(index);trace.append("S");return observe(mode==2?"failure:"+index+":"+polls+":"+trace:done(index,polls,trace),trace);}
            String failureKind=null;boolean returned=false,nextRound=false,endRounds=false;
            if(monitor&&lock==null)failureKind="java.lang.NullPointerException";
            else{if(monitor)trace.append("L");trace.append("B");if(mode==1)failureKind="failure";else if(mode==10)failureKind="fatal";else{index++;returned=mode==4;escapedStop=mode==5;nextRound=mode==6;}}
            if(kind==3&&failureKind!=null&&!failureKind.equals("fatal")){trace.append(failureKind.equals("failure")?"C":"G");failureKind=null;returned=true;}
            String returnSnapshot=returned?done(index,polls,trace):null;
            if(finalizer){trace.append("F");if(mode==3)failureKind="failure";else if(mode==7){failureKind=null;returned=true;returnSnapshot=done(index,polls,trace);}else if(mode==8){failureKind=null;returned=false;escapedStop=false;nextRound=false;}else if(mode==9){failureKind=null;returned=false;escapedStop=false;nextRound=false;endRounds=true;}}
            if(failureKind!=null)return observe(failureKind+":"+index+":"+polls+":"+trace,trace);
            if(returned)return observe(returnSnapshot,trace);
            if(endRounds)return observe(done(index,polls,trace),trace);
            if(escapedStop||nextRound){if(escapedStop)trace.append("E");break;}
          }
        }
        return observe(done(index,polls,trace),trace);
      }
      ${methods}
      public static void main(String[]args){int count=0;for(int limit=-5;limit<=25;limit++)for(Boolean gate:new Boolean[]{null,false,true})for(int mode=0;mode<12;mode++)for(Object lock:new Object[]{null,new Object()}){${variants.map((_,i)=>`compare${i}(limit,gate,mode,lock);count++;`).join('')}}System.out.println("comparisons:"+count+":oracles:"+count+":variants:${variants.length}");}
    }`;
    const file = path.join(temporary, 'GuardedLoopBehavior.java'); fs.writeFileSync(file, source);
    run('javac', ['--release', '8', '-d', temporary, file]);
    assert.equal(run('java', ['-cp', temporary, 'GuardedLoopBehavior']).trim(), `comparisons:${comparisons}:oracles:${comparisons}:variants:${variants.length}`);
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
