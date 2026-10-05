'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {foldBooleanLocalAssignments:fold}=require('../src/decompiler/javaAstEmitter');
const {tokenizeJava}=require('../src/java-frontend/lexer');

test('opposite Boolean literal branches become one primitive-local assignment',()=>{
  for(const [source,expected]of[
    ['boolean ready=false;if(boxed){ready=false;}else{ready=true;}use(ready);','boolean ready=false;ready = !(boxed);use(ready);'],
    ['final boolean ready;if(call())ready=true;else ready=false;return ready;','final boolean ready;ready = (call());return ready;'],
    ['boolean ready=false;if((ready=read())&&boxed||floating<2.0f){ready=false;}else{ready=true;}','boolean ready=false;ready = !((ready=read())&&boxed||floating<2.0f);'],
    ['boolean a=false,b=false;if(call()){a=true;}else a=false;if(other())b=false;else{b=true;}','boolean a=false,b=false;a = (call());b = !(other());'],
  ]){const next=fold(source,{retainDiagnostics:true});assert.equal(next.source,expected);assert.equal(fold(next.source).assignmentsFolded,0);}
});

test('local scope, protected constructs and declaration identity stay intact',()=>{
  const source='Outer:while(run()){try{synchronized(lock){boolean ready=false;if(read()){ready=false;}else{ready=true;}use(ready);if(ready)continue Outer;}}finally{finish();}}';
  const next=fold(source);assert.equal(next.assignmentsFolded,1);assert.equal(next.blocksRemoved,2);
  assert.equal(next.source,source.replace('if(read()){ready=false;}else{ready=true;}','ready = !(read());'));
  assert.equal(fold('{boolean ready;if(read()){ready=true;}else{ready=false;}}if(other()){ready=true;}else{ready=false;}').assignmentsFolded,1);
});

test('diagnostics independently preserve each condition and one attributed local store',()=>{
  const source='boolean ready=false;if(read(first++)&&boxed){ready=false;}else{ready=true;}';
  const next=fold(source,{retainDiagnostics:true}),d=next.diagnostics.assignments[0];
  assert.equal(source.slice(d.nameRange.start,d.nameRange.end),'ready');assert.equal(source.slice(d.discardedNameRange.start,d.discardedNameRange.end),'ready');
  assert.equal(source.slice(d.conditionRange.start,d.conditionRange.end),'(read(first++)&&boxed)');assert.equal(d.inverted,true);
  const lexical=s=>tokenizeJava(s).tokens.filter(t=>!['whitespace','eof'].includes(t.kind));const original=lexical(source);
  const slice=r=>original.filter(t=>t.range.startOffset>=r.start&&t.range.endOffset<=r.end).map(t=>t.text);
  const expected=[...slice({start:0,end:d.range.start}),...slice(d.nameRange),'=','!',...slice(d.conditionRange),';',...slice({start:d.range.end,end:source.length})];
  assert.deepEqual(lexical(next.source).map(t=>t.text),expected);
});

test('boxed, field, array, ambiguous and effectful destinations refuse',()=>{
  for(const source of[
    'Boolean ready=null;if(read()){ready=true;}else{ready=false;}',
    'boolean[] ready=null;if(read()){ready[0]=true;}else{ready[0]=false;}',
    'boolean ready=false;if(read()){this.ready=true;}else{this.ready=false;}',
    'boolean ready=false;if(read()){receiver().ready=true;}else{receiver().ready=false;}',
    'boolean ready=false;if(read()){ready=true;hit();}else{ready=false;}',
    'boolean ready=false;if(read()){ready=true;}else{other=false;}',
    'boolean ready=false;if(read()){ready=true;}else{ready=true;}',
    'boolean ready=false;if(read()){ready=true;}',
    'boolean ready=false;if(read()){ready&=true;}else{ready=false;}',
    '{boolean ready=false;}if(read()){ready=true;}else{ready=false;}',
    '{boolean ready=false;if(read()){ready=true;}else{ready=false;}}{boolean ready=false;}',
    'boolean ready=false;if(read()){ready=(true);}else{ready=false;}',
  ])assert.equal(fold(source).source,source,source);
});

test('unsupported syntax, nested executables, translated offsets and budgets refuse',()=>{
  const good='boolean ready=false;if(read()){ready=true;}else{ready=false;}';
  for(const source of[good+' // comment\n',good+'\\u000a',good+'Runnable r=()->hit();',good+'class Nested{void run(){}}',good+'Object holder=new Object(){};',
    good+'Object holder=new Object(){boolean field;};',good+'if(',good+' '.repeat(400001)])assert.equal(fold(source).source,source);
  assert.equal(fold(good,{retainDiagnostics:1}).source,good);
  const many='boolean ready=false;'+Array(257).fill('if(read()){ready=true;}else{ready=false;}').join('');assert.equal(fold(many).source,many);
  const long='boolean ready=false;if(text.equals("'+'x'.repeat(45000)+'")){ready=true;}else{ready=false;}';assert.equal(fold(long).source,long);
  assert.equal(fold('boolean ready=false;if(text.equals("//")){ready=true;}else{ready=false;}').assignmentsFolded,1);
});

test('native Boolean assignments match independent truth/completion models with partial effects',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'boolean-local-assignment-native-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const condition='(value=probe(flags,inject,0))&&boxed||probe(flags,inject,1)&&floating<2.0f';
  const actions="trace.append(value?'T':'N');event(7,flags);if(inject==3)throw FAILURE;if(mode==1)continue Outer;if(mode==2)return value+\":\"+round+\":\"+effects;if(mode==3)throw FAILURE;";
  const finish="trace.append('F');if(mode==4)return \"override:\"+value+\":\"+effects;if(mode==5)throw OTHER;";
  const contexts=[body=>body,body=>`try{${body}}finally{${finish}}`,body=>`synchronized(lock){trace.append('L');${body}}`,
    body=>`try{${body}}catch(IllegalStateException ex){trace.append('C');if(ex!=FAILURE)throw ex;}finally{${finish}}`,
    body=>`try{synchronized(lock){trace.append('L');${body}}}finally{${finish}}`,body=>`{${body}}`];
  const wrap=(body,index)=>`boolean value=(seed&1)!=0;Boolean boxed=pool[boxedId];Outer:for(int round=0;round<2;round++){${contexts[index](body+actions)}}return value+":"+effects;`;
  const signature='int flags,int inject,int boxedId,float floating,int seed,int mode,Object lock';
  const args='flags,inject,boxedId,floating,seed,mode,lock';
  try{
    let methods='';for(let context=0;context<contexts.length;context++)for(let negative=0;negative<2;negative++){
      const n=context*2+negative,lhs=context===5?'scoped':'value';
      const branch=`if(${condition}){${lhs}=${negative?'false':'true'};}else{${lhs}=${negative?'true':'false'};}`;
      const old=wrap((context===5?'boolean scoped=false;':'')+branch+(context===5?'value=scoped;':''),context),next=fold(old);
      assert.equal(next.assignmentsFolded,1);assert.equal(fold(next.source).assignmentsFolded,0);
      const oracleCore=`boolean first=probe(flags,inject,0);value=first;boolean choice=false;if(first){boolean second=boxed.booleanValue();if(second)choice=true;}if(!choice){boolean second=probe(flags,inject,1);if(second)choice=!Float.isNaN(floating)&&floating<2.0f;}${lhs}=truth[${negative}][choice?1:0];`;
      const oracle=wrap((context===5?'boolean scoped=false;':'')+oracleCore+(context===5?'value=scoped;':''),context);
      methods+=`static String old${n}(${signature}){${old}}\nstatic String next${n}(${signature}){${next.source}}\nstatic String oracle${n}(${signature}){${oracle}}\n`;
    }
    const fixture=`public class BooleanAssignmentNative {
static final RuntimeException FAILURE=new IllegalStateException("injected"),OTHER=new IllegalStateException("finally");
static final Boolean[] pool={Boolean.FALSE,Boolean.TRUE,null};static final boolean[][] truth={{false,true},{true,false}};
static StringBuilder trace;static int effects;
static void event(int stage,int flags){trace.append((char)('a'+stage));effects=effects*31+stage+flags;}
static boolean probe(int flags,int inject,int stage){event(stage,flags);if(inject==stage+1)throw FAILURE;return stage==0?flags!=0:flags>=0;}
${methods}
static String take(int kind,int variant,${signature}){trace=new StringBuilder();effects=seed;String outcome;try{switch(kind){${Array.from({length:12},(_,i)=>`case ${i}:outcome=variant==0?old${i}(${args}):variant==1?next${i}(${args}):oracle${i}(${args});break;`).join('')}default:throw new AssertionError();}}catch(Throwable ex){outcome=ex==FAILURE?"failure":ex==OTHER?"override-failure":ex.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return outcome+":"+effects+":"+trace;}
public static void main(String[] args){int cases=0;float[] numbers={Float.NaN,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY,-0.0f,0.0f,1.0f,2.0f,3.0f};for(int kind=0;kind<12;kind++)for(int flags:new int[]{-1,0,1})for(int boxedId=0;boxedId<3;boxedId++)for(int inject=0;inject<4;inject++)for(float floating:numbers)for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE})for(int mode=0;mode<6;mode++)for(Object lock:new Object[]{null,new Object()}){String want=take(kind,2,${args});for(int variant=0;variant<2;variant++){String got=take(kind,variant,${args});if(!want.equals(got))throw new AssertionError(kind+":"+flags+":"+boxedId+":"+inject+":"+floating+":"+seed+":"+mode+":"+variant+"\\n"+want+"\\n"+got);}cases++;}System.out.println(cases+" independent cases / 6 contexts");}}
`;
    const file=path.join(temporary,'BooleanAssignmentNative.java');fs.writeFileSync(file,fixture);
    run('javac',['--release','8','-d',temporary,file]);assert.equal(run('java',['-XX:-OmitStackTraceInFastThrow','-Xmx128m','-cp',temporary,'BooleanAssignmentNative']).trim(),'124416 independent cases / 6 contexts');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
