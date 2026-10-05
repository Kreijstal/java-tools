'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {simplifyPredicateGrouping:simplify}=require('../src/decompiler/javaAstEmitter');
const {tokenizeJava}=require('../src/java-frontend/lexer');

test('control-condition grouping preserves precedence and reaches a fixed point',()=>{
  const source='if((((a&&b))||((c&&d))))hit();';
  const next=simplify(source,{retainDiagnostics:true});
  assert.equal(next.source,'if(a&&b||c&&d)hit();');
  assert.equal(next.conditionsSimplified,1);assert.equal(next.parenthesisPairsRemoved,5);
  assert.equal(simplify(next.source).parenthesisPairsRemoved,0);
  assert.equal(simplify('if (((((settled()) && (!processed))) || (!(preserve))) && (canAdvance())) hit();').source,
    'if ((settled() && !processed || !preserve) && canAdvance()) hit();');
});

test('same-precedence right association and mixed lower-precedence groups remain explicit',()=>{
  for(const source of ['if(a&&(b&&c))hit();','if(a||(b||c))hit();','if((a||b)&&c)hit();','if(!(a&&b))hit();'])
    assert.equal(simplify(source).source,source);
  assert.equal(simplify('if(((a&&b))&&((c&&d)))hit();').source,'if(a&&b&&(c&&d))hit();');
  assert.equal(simplify('if(((a||b))&&((c||d)))hit();').source,'if((a||b)&&(c||d))hit();');
});

test('numeric grouping, cast operands, call arguments and boxed comparisons stay intact',()=>{
  for(const [source,expected] of [
    ['if(((((a+b)*c)<limit)))hit();','if(((a+b)*c)<limit)hit();'],
    ['if((((!!boxed)==other)))hit();','if((!!boxed)==other)hit();'],
    ['if(!(((floating<other))))hit();','if(!(floating<other))hit();'],
    ['if((call(((a+b)*c),((Boolean)value))))hit();','if(call(((a+b)*c),((Boolean)value)))hit();'],
    ['if((!((Boolean)value)))hit();','if(!((Boolean)value))hit();'],
    ['if(((mask&flag)==0)&&((ready)))hit();','if((mask&flag)==0&&ready)hit();'],
  ])assert.equal(simplify(source).source,expected);
  const source='Boolean value=(((!!boxed)));consume(((ready)));return ((result));';
  assert.equal(simplify(source).source,source,'non-control contexts are not rewritten');
});

test('if, while, braced do-while and for conditions retain syntax and protected scope',()=>{
  const source='try{synchronized(lock){if(((a)))hit();while(((b))){break;}do{step();}while(((c)));for(int i=0;((i<3))&&((d));i++){step();}}}finally{finish();}';
  const next=simplify(source);
  assert.equal(next.source,'try{synchronized(lock){if(a)hit();while(b){break;}do{step();}while(c);for(int i=0;i<3&&d;i++){step();}}}finally{finish();}');
  assert.equal(next.conditionsSimplified,4);assert.equal(next.parenthesisPairsRemoved,10);
  assert.equal(simplify('for(;;){if(((ready)))break;}').source,'for(;;){if(ready)break;}');
});

test('diagnostics delete only paired grouping tokens and preserve every other token',()=>{
  const source='Outer:{try{if((((read(a++))&&(ready||(!boxed)))))break Outer;}finally{finish();}}';
  const next=simplify(source,{retainDiagnostics:true});let expected=source;
  assert.equal(next.diagnostics.deletedRanges.length,next.parenthesisPairsRemoved*2);
  assert.deepEqual(new Set(next.diagnostics.deletedRanges.map(r=>r.start)),new Set(next.diagnostics.pairs.flatMap(p=>[p.open,p.close])));
  for(const edit of next.diagnostics.deletedRanges.slice().reverse()){
    assert.equal(edit.end-edit.start,1);assert.ok(['(',')'].includes(source.slice(edit.start,edit.end)));
    expected=expected.slice(0,edit.start)+expected.slice(edit.end);
  }
  assert.equal(next.source,expected);
  const selected=new Set(next.diagnostics.deletedRanges.map(r=>r.start));
  const tokens=s=>tokenizeJava(s).tokens.filter(t=>!['whitespace','eof'].includes(t.kind));
  assert.deepEqual(tokens(next.source).map(t=>t.text),tokens(source).filter(t=>!selected.has(t.range.startOffset)).map(t=>t.text));
});

test('uncertain syntax, comments, translated Unicode, nested executables and budgets refuse',()=>{
  const good='if(((ready)))hit();';
  for(const source of [good+' // comment\n',good+'\\u000a',good+'Runnable r=()->hit();',
    good+'class Nested{void run(){}}',good+'if(',good+' '.repeat(400001)])
    assert.equal(simplify(source).source,source);
  assert.equal(simplify(good,{retainDiagnostics:1}).source,good);
  assert.equal(simplify('if(((text.equals("//"))))hit();').source,'if(text.equals("//"))hit();');
});

test('native grouping matches independent control/event models through boxing, NaNs and protected completion',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'predicate-grouping-native-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const variants=[
    {body:'if((((probe(flags,inject,nullable,0)))&&(((probe(flags,inject,nullable,1))||(probe(flags,inject,nullable,2))))))result=true;',
      oracle:'boolean first=probe(flags,inject,nullable,0);if(first){boolean second=probe(flags,inject,nullable,1);if(second)result=true;else result=probe(flags,inject,nullable,2);}'},
    {body:'if((((probe(flags,inject,nullable,0))&&((probe(flags,inject,nullable,1))&&(probe(flags,inject,nullable,2))))))result=true;',
      oracle:'boolean first=probe(flags,inject,nullable,0);if(first){boolean second=probe(flags,inject,nullable,1);if(second)result=probe(flags,inject,nullable,2);}'},
    {body:'while((((i<limit))&&((probe(flags,inject,nullable,0))))){i++;probe(flags,inject,nullable,1);if((((flags&1)!=0)))break;}',
      oracle:'for(;;){if(i>=limit)break;boolean first=probe(flags,inject,nullable,0);if(!first)break;i++;probe(flags,inject,nullable,1);if((flags&1)!=0)break;}'},
    {body:'for(i=0;(((i<limit))&&((probe(flags,inject,nullable,0))));i++){probe(flags,inject,nullable,1);if((((flags&1)!=0)))break;}',
      oracle:'i=0;for(;;){if(i>=limit)break;boolean first=probe(flags,inject,nullable,0);if(!first)break;probe(flags,inject,nullable,1);if((flags&1)!=0)break;i++;}'},
    {body:'if((((boxed==other))))result=true;',oracle:'result=boxId==otherId;'},
    {body:'if(((((a+(b*c))<((a+b)*c)))||(!((floating>2.0f)))))result=true;',
      oracle:'int product=b*c;int left=a+product;int sum=a+b;int right=sum*c;result=Integer.compare(left,right)<0;if(!result)result=Float.isNaN(floating)||floating<=2.0f;'},
  ];
  const signature='int flags,int inject,int nullable,int limit,int boxId,int otherId,int a,int b,int c,float floating,int mode,Object lock';
  const argumentsText='flags,inject,nullable,limit,boxId,otherId,a,b,c,floating,mode,lock';
  const wrap=body=>`int i=0;boolean result=false;Boolean boxed=pool[boxId],other=pool[otherId];try{synchronized(lock){trace.append('L');${body}trace.append(result?'T':'N');return result+":"+i+":"+effects+":"+trace;}}finally{trace.append('F');if(((mode==1)))throw FAILURE;if(((mode==2)))return "override:"+i+":"+effects+":"+trace;}`;
  try{
    let methods='';variants.forEach((v,i)=>{const old=wrap(v.body),next=simplify(old,{retainDiagnostics:true});
      assert.ok(next.parenthesisPairsRemoved>0);assert.equal(simplify(next.source).parenthesisPairsRemoved,0);
      methods+=`static String old${i}(${signature}){${old}}\nstatic String next${i}(${signature}){${next.source}}\nstatic String oracle${i}(${signature}){${wrap(v.oracle)}}\n`;
    });
    const fixture=`public class GroupingNative {
      static StringBuilder trace;static int effects;static final RuntimeException FAILURE=new RuntimeException();
      static Boolean[]pool={null,Boolean.TRUE,new Boolean(true),Boolean.FALSE,new Boolean(false)};
      static Boolean probe(int flags,int inject,int nullable,int stage){trace.append(stage);effects+=17;if(inject==stage)throw FAILURE;if(nullable==stage)return null;return (flags&(1<<stage))!=0;}
      ${methods}
      static String invoke(int kind,int variant,${signature}){trace=new StringBuilder();effects=(flags&2)==0?0:Integer.MAX_VALUE;try{switch(variant){
        ${variants.map((_,i)=>`case ${i}:return kind==0?old${i}(${argumentsText}):kind==1?next${i}(${argumentsText}):oracle${i}(${argumentsText});`).join('')}
      }throw new AssertionError();}catch(Throwable e){String type=e==FAILURE?"injected":e instanceof NullPointerException?"null":null;if(type==null)throw new AssertionError(e);return type+":"+effects+":"+trace;}}
      public static void main(String[]args){Object monitor=new Object();int cases=0;
        for(int variant=0;variant<6;variant++)for(int flags:new int[]{-5,-1,0,1,2,7,8,Integer.MIN_VALUE,Integer.MAX_VALUE})for(int inject=-1;inject<3;inject++)for(int nullable=-1;nullable<3;nullable++)
        for(int limit:new int[]{-1,0,3})for(int[]ids:new int[][]{{0,0},{1,1},{1,2},{3,4},{0,2}})for(int[]p:new int[][]{{0,1,2},{Integer.MIN_VALUE,Integer.MAX_VALUE,2},{Integer.MAX_VALUE,-1,Integer.MIN_VALUE}})
        for(float f:new float[]{Float.NaN,-0.0f,Float.POSITIVE_INFINITY})for(int mode=0;mode<4;mode++){
          Object lock=mode==3?null:monitor;String expected=invoke(2,variant,flags,inject,nullable,limit,ids[0],ids[1],p[0],p[1],p[2],f,mode,lock);
          for(int kind=0;kind<2;kind++){String actual=invoke(kind,variant,flags,inject,nullable,limit,ids[0],ids[1],p[0],p[1],p[2],f,mode,lock);if(!actual.equals(expected))throw new AssertionError(variant+":"+actual+" != "+expected);if(Thread.holdsLock(monitor))throw new AssertionError("monitor leaked");}cases++;
        }System.out.println(cases+" independent grouping cases");}
    }`;
    const file=path.join(temporary,'GroupingNative.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);
    assert.equal(run('java',['-XX:-OmitStackTraceInFastThrow','-Xmx128m','-cp',temporary,'GroupingNative']).trim(),'466560 independent grouping cases');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
