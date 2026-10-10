'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {compactLocalBooleanGuards: fold, reindentStructuredSource: indent} = require('../src/decompiler/javaAstEmitter');
const {tokenizeJava} = require('../src/java-frontend/lexer');

test('primitive local guards combine conditional stores in their original order', () => {
  let source = 'boolean f=true; if(f){f=one();if(f){f=two();if(f){run();}}} after(f);';
  let count = 0;
  for (;;) {
    const result = fold(source, {retainDiagnostics: true});
    if (!result.guardsCompacted) break;
    const d = result.diagnostics;
    assert.equal(result.source, source.slice(0,d.range.start) + d.segments.map(s=>s.text??source.slice(s.range.start,s.range.end)).join('') + source.slice(d.range.end));
    source = result.source; count++;
  }
  assert.equal(count,2);
  assert.ok(source.replace(/\s+/g,'').includes('if((f)&&(f=one())&&(f=two()))'));
  for (const call of ['one()','two()','run()','after(f)']) assert.equal(source.split(call).length-1,1);
});

test('boxed/field/shadowed/later locals, extra actions, else arms and captures refuse', () => {
  for (const source of [
    'Boolean f=true;if(f){f=one();if(f){run();}}',
    'if(f){f=one();if(f){run();}}',
    '{boolean f=true;}if(f){f=one();if(f){run();}}',
    'if(f){f=one();if(f){run();}}boolean f=true;',
    '{boolean f=true;}boolean f=true;if(f){f=one();if(f){run();}}',
    'boolean f=true;if(f){f=one();extra();if(f){run();}}',
    'boolean f=true;if(f){f=one();if(f){run();}else other();}',
    'boolean f=true;if(f){f=one();if(f){run();}}else other();',
    'boolean f=true;Label:if(f){f=one();if(f){run();}}',
    'boolean f=true;if(f){f=one();if(f){run();}}Runnable r=()->other();',
    'boolean f=true;if(f){f=one();if(f){run();}}// comment\n'
  ]) assert.equal(fold(source).source,source,source);
  const source='boolean f=true;if(f){f=one();if(f){run();}}';
  assert.equal(fold(source,{reservedNames:['f']}).source,source);
  assert.equal(fold(source,{reservedNames:null}).source,source);
});

test('indentation preserves token bytes and line endings, including quoted delimiters and switch cases', () => {
  const source='int x=0;\nif(ok()){\nwork("{ // } /*", \n  x);\nif(next()){\n x++;\n}\n}\nswitch(x){\ncase 1:\nwork();\nif(ok()){\nmore();\n}\nbreak;\ndefault:\nother();\n}\n';
  const result=indent(source,{retainDiagnostics:true});
  assert.ok(result.linesReindented>0);
  const values=s=>tokenizeJava(s).tokens.map(t=>[t.kind,t.text]);
  assert.deepEqual(values(result.source),values(source));
  assert.equal(result.source.split('\n').length,source.split('\n').length);
  assert.match(result.source,/\n  case 1:\n    work\(\);\n    if\(ok\(\)\)\{\n      more/);
  assert.match(result.source,/\n  if\(next\(\)\)\{\n    x\+\+;/);
  assert.equal(indent(result.source).linesReindented,0);
  for(const s of ['work(); // keep\n','work("\\u007b");','/* keep */\nwork();'])assert.equal(indent(s).source,s);
});

test('native compound guards preserve flag stores on partial failure and skip nullable RHS values', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boolean-guard-native-'));
  const run=(command,args)=>{const outputs=['out','err'].map(n=>path.join(dir,n)),fds=outputs.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(outputs[1],'utf8'));for(const f of outputs)assert.ok(fs.statSync(f).size<=1024*1024);return fs.readFileSync(outputs[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
  const wraps=[s=>`try{${s}}finally{observed=flag;}`,s=>`try{${s}}finally{observed=flag;event(9);if(mode==1)return snapshot(flag);if(mode==2)throw OVERRIDE;}`,s=>`try{synchronized(lock){${s}}}finally{observed=flag;}`,s=>`try{${s}}catch(IllegalStateException e){event(8);if(e!=FAILURE)throw e;}finally{observed=flag;event(9);}return snapshot(flag);`];
  try {
    let methods='';
    for(let m=0;m<wraps.length;m++) {
      const original='boolean flag=initial;'+wraps[m]('if(flag){flag=(flag=choice(first,1)) ^ risky(seed,2);if(flag){flag=choice(second,3);if(flag){event(4);value+=seed;}}}event(5);return snapshot(flag);');
      let next=original, count=0;
      for(;;){const r=fold(next);if(!r.guardsCompacted)break;next=r.source;count++;}
      assert.equal(count,2);next=indent(next).source;
      const oracle='boolean flag=initial;'+wraps[m]('if(flag){event(1);if(first==null)throw new NullPointerException();flag=first==Boolean.TRUE;event(2);flag=flag ^ ((seed & 1)!=0);if(flag){event(3);if(second==null)throw new NullPointerException();flag=second==Boolean.TRUE;if(flag){event(4);value+=seed;}}}event(5);return snapshot(flag);');
      for(const [name,body] of [['old',original],['next',next],['oracle',oracle]])methods+=`static String ${name}${m}(boolean initial,Boolean first,Boolean second,int seed,int mode){${body}}\n`;
    }
    const java=`public class BooleanGuardOracle{
      static int value,count,failAt;static boolean observed;static Object lock;static StringBuilder trace;
      static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
      static void event(int n){value=value*31+n;trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}
      static boolean choice(Boolean x,int n){event(n);return x.booleanValue();}
      static boolean risky(int seed,int n){event(n);return(seed & 1)!=0;}
      static String snapshot(boolean flag){return flag+":"+value+":"+count+":"+trace;}
      ${methods}
      static String take(int model,int variant,boolean initial,Boolean first,Boolean second,int seed,int mode){value=seed;count=0;observed=false;lock=new Object();trace=new StringBuilder();String result;try{switch(model){${wraps.map((_,m)=>`case ${m}:result=variant==0?old${m}(initial,first,second,seed,mode):variant==1?next${m}(initial,first,second,seed,mode):oracle${m}(initial,first,second,seed,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+observed+":"+snapshot(observed);}
      public static void main(String[]args){int cases=0;for(int model=0;model<${wraps.length};model++)for(boolean initial:new boolean[]{false,true})for(Boolean first:new Boolean[]{false,true,null})for(Boolean second:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int mode=0;mode<3;mode++)for(int failure=-1;failure<12;failure++){failAt=failure;String expected=take(model,2,initial,first,second,seed,mode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,initial,first,second,seed,mode);if(!expected.equals(actual))throw new AssertionError(model+":"+initial+":"+first+":"+second+":"+seed+":"+mode+":"+failure+":"+expected+":"+actual);}cases++;}System.out.println(cases);}
    }`;
    fs.writeFileSync(dir+'/BooleanGuardOracle.java',java);run('javac',['--release','8','-d',dir,dir+'/BooleanGuardOracle.java']);assert.equal(run('java',['-Xmx128m','-cp',dir,'BooleanGuardOracle']),'14040');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('compiler compacts guards and indents their work by default',()=>{
 const finish=require('../src/decompiler/cfr')._internals.shareExistingExitTails,body=['boolean f=true;\nif(f){\nf=one();\nif(f){\nrun();\n}\n}'];
 finish(body);assert.match(body.join('\n'),/f=one\(\)/);assert.match(body.join('\n'),/\n  run\(\)/);assert.equal((body.join('\n').match(/if\s*\(/g)||[]).length,1);
});

test('final rendering normalizes later wrappers without changing tokens or input',()=>{
 const {formatBlock}=require('../src/decompiler/cfr')._internals;
 const body=['try {','    boolean flag=true;','    if(flag) {','        work();','    }','} catch (RuntimeException e) {','    throw e;','}'];
 const result=formatBlock('void run()',body);assert.match(result,/\n      boolean flag=true;/);assert.match(result,/\n        work\(\);/);
 assert.deepEqual(tokenizeJava(result).tokens.map(t=>t.text),tokenizeJava('void run(){'+body.join('\n')+'}').tokens.map(t=>t.text));assert.equal(body[1],'    boolean flag=true;');
});
