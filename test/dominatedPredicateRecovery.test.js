'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {simplifyDominatedPredicates:simplify}=require('../src/decompiler/javaAstEmitter');

test('enclosing branches establish Boolean identities for a stable scoped int snapshot',()=>{
  const cases=[
    ['int flag=read();if(flag==0&&(ready()&&flag==0))hit();', 'int flag=read();if(flag==0&&(ready()))hit();'],
    ['int flag=read();if(flag!=0||(ready()&&flag==0))hit();', 'int flag=read();if(flag!=0||(ready()))hit();'],
    ['int flag=read();if(flag==0){if(ready()&&flag==0)hit();}', 'int flag=read();if(flag==0){if(ready())hit();}'],
    ['int flag=read();if(flag==0){if(flag!=0||ready())hit();}', 'int flag=read();if(flag==0){if(ready())hit();}'],
    ['int flag=read();if(flag==0){if((flag==0)&&ready())hit();}', 'int flag=read();if(flag==0){if(ready())hit();}'],
    ['int flag=read();if(flag==0){hit();}else{if(ready()||flag==0)hit();}', 'int flag=read();if(flag==0){hit();}else{if(ready())hit();}'],
    ['int flag=read();if(!(flag!=0)){if(ready()&&!(flag!=0))hit();}', 'int flag=read();if(!(flag!=0)){if(ready())hit();}'],
    ['int flag=read();if(flag==1&&allowed()){if(ready()&&flag!=0)hit();}', 'int flag=read();if(flag==1&&allowed()){if(ready())hit();}'],
    ['int flag=read();if(!(flag==0||flag==1)){if(ready()&&flag!=0&&flag!=1)hit();}', 'int flag=read();if(!(flag==0||flag==1)){if(ready())hit();}'],
    ['int flag=read();if(flag==0){if((!!boxed)==other&&flag==0)hit();}', 'int flag=read();if(flag==0){if((!!boxed)==other)hit();}'],
    ['try{int flag=read();if(flag==0){if(ready()&&flag==0)hit();}}finally{finish();}', 'try{int flag=read();if(flag==0){if(ready())hit();}}finally{finish();}'],
  ];
  for(const [source,expected]of cases){const r=simplify(source,{retainDiagnostics:true});assert.equal(r.source,expected);assert.ok(r.conditionsSimplified>0);assert.equal(simplify(r.source).conditionsSimplified,0);}
});

test('loop headers and protected bodies retain nonconstant conditions, actions and transfers',()=>{
  for(const source of [
    'int flag=read();if(flag==0){while(ready()&&flag==0){hit();break;}}',
    'int flag=read();while(flag==0){if(ready()&&flag==0)break;}finish();',
    'int flag=read();for(;flag==0;){if(ready()&&flag==0)break;}finish();',
    'int flag=read();if(flag==0){do{hit();}while(ready()&&flag==0);}',
    'int flag=read();if(flag==0){for(;ready()&&flag==0;step()){hit();break;}}',
    'int flag=read();if(flag==0){try{if(ready()&&flag==0)hit();}catch(java.io.IOException e){fail();}finally{finish();}}',
    'int flag=read();if(flag==0){synchronized(lock){if(ready()&&flag==0)hit();}}',
    'int flag=read();if(flag==0){Outer:{if(ready()&&flag==0)break Outer;finish();}}',
    'int flag=read();if(flag==0){switch(value){case 0:if(ready()&&flag==0)hit();break;default:break;}}',
  ]){const r=simplify(source);assert.ok(r.conditionsSimplified>0,source);assert.equal(r.source,source.replace('ready()&&flag==0','ready()'));}
  const source='int flag=read();if(flag==0){while(ALWAYS&&flag==0){hit();}finish();}';
  assert.equal(simplify(source).source,source,'unknown fields may be compile-time constants');
});

test('unknown or changing values and absorbing paths cannot erase predicates or unknown atoms',()=>{
  for(const source of [
    'if(flag==0){if(ready()&&flag==0)hit();}',
    'float flag=read();if(flag==0){if(ready()&&flag==0)hit();}',
    'Integer flag=read();if(flag==0){if(ready()&&flag==0)hit();}',
    'int flag=read();if(flag==0){flag++;if(ready()&&flag==0)hit();}',
    'int flag=read();if(flag==0){if(ready()&&flag==0)hit();}flag=1;',
    'int flag=read();while(next()){if(flag==0){if(ready()&&flag==0)hit();}flag++;}',
    'while(next()){int flag=read();if(flag==0){if(ready()&&flag==0)hit();}}',
    'int flag=read();if(flag==0){if(ready()&&flag!=0)hit();}',
    'int flag=read();if(flag==0){if(flag!=0&&ready())hit();}',
    'int flag=read();if(flag==0){if(flag==0)hit();}',
    'int flag=read();if(flag==0||allowed()){if(ready()&&flag==0)hit();}',
    'int flag=read();if(flag==0){consume(ready()&&flag==0);}',
    'int flag=read();if(flag==0){if(compare(ready()&&flag==0))hit();}',
    'int flag=read();{int flag=read();if(flag==0){if(ready()&&flag==0)hit();}}',
    'int flag=read();if(flag==0){if(ready()&&global.flag==0)hit();}',
    'int flag=read();switch(value){case 0:if(flag==0)hit();case 1:if(ready()&&flag==0)hit();}',
  ])assert.equal(simplify(source).source,source,source);
});

test('deletion diagnostics identify every removed pure comparison and preserve all other bytes',()=>{
  const source='int flag=read();if(flag==0){if(((flag==0)&&call(first!=second,boxed==other))&&(flag!=1))hit();}';
  const r=simplify(source,{retainDiagnostics:true});assert.equal(r.conditionsSimplified,1);assert.equal(r.diagnostics.counts.comparisonsRemoved,2);
  let expected=source;for(const edit of r.diagnostics.deletedRanges.slice().reverse())expected=expected.slice(0,edit.start)+expected.slice(edit.end);
  assert.equal(r.source,expected);assert.ok(r.source.includes('call(first!=second,boxed==other)'));
  for(const c of r.diagnostics.removedComparisons){assert.equal(c.name,'flag');assert.equal(c.fact.guardSite,source.indexOf('if(flag==0)'));assert.equal(c.fact.branch,true);assert.equal(c.known,true);assert.match(source.slice(c.start,c.end),/^flag[!=]=[01]$/);}
  const good='int flag=read();if(flag==0){if(ready()&&flag==0)hit();}';
  for(const source of [good+' // x\n',good+'\\u000a',good+'Runnable r=()->hit();',good+'class Nested{void f(){hit();}}',good+'if(',good+' '.repeat(400001)])assert.equal(simplify(source).source,source);
  assert.equal(simplify(good,{retainDiagnostics:1}).source,good);assert.equal(simplify(good,{parameterNames:null}).source,good);
});

test('native dominated predicates match independent ordered oracles with callbacks, NaN, boxing and protected exits',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dominated-predicate-native-'));
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const variants=[
    ['if(flag==0){if(probe(0,mode,boxed)&&flag==0)hit();}else{if(probe(1,mode,boxed)||flag==0)hit();}', 'if(flag==0){boolean value=probe(0,mode,boxed);if(value)hit();}else{boolean value=probe(1,mode,boxed);if(value)hit();}'],
    ['if((flag==0)&&((probe(0,mode,boxed)&&flag==0)||flag!=0))hit();', 'if(flag==0){boolean value=probe(0,mode,boxed);if(value)hit();}'],
    ['if(flag!=0||(probe(0,mode,boxed)&&flag==0))hit();', 'if(flag!=0)hit();else{boolean value=probe(0,mode,boxed);if(value)hit();}'],
    ['if(flag==0){if(flag==0&&probe(0,mode,boxed))hit();}', 'if(flag==0){boolean value=probe(0,mode,boxed);if(value)hit();}'],
    ['if(flag==0){while(probe(0,mode,boxed)&&flag==0){hit();}}', 'if(flag==0){while(true){boolean value=probe(0,mode,boxed);if(!value)break;hit();}}'],
    ['if(flag==0){do{hit();}while(probe(0,mode,boxed)&&flag==0);}', 'if(flag==0){for(;;){hit();boolean value=probe(0,mode,boxed);if(!value)break;}}'],
    ['if(flag==0){for(;probe(0,mode,boxed)&&flag==0;trace.append("U")){hit();}}', 'if(flag==0){for(;;){boolean value=probe(0,mode,boxed);if(!value)break;hit();trace.append("U");}}'],
    ['if(!(flag==0||flag==1)){if(probe(0,mode,boxed)&&flag!=0&&flag!=1)hit();}', 'if(flag!=0&&flag!=1){boolean value=probe(0,mode,boxed);if(value)hit();}'],
    ['if(flag==0){if((probe(0,mode,boxed)==other)||flag!=0)hit();}', 'if(flag==0){Boolean value=probe(0,mode,boxed);if(value==other)hit();}'],
    ['if(flag==0){Outer:{if((fa<fb)||flag!=0){hit();break Outer;}trace.append("S");}}', 'if(flag==0){boolean value=fa<fb;if(value)hit();else trace.append("S");}'],
  ];
  const parameters='int input,int mode,Boolean boxed,Boolean other,float fa,float fb,Object lock';
  const wrap=source=>`int flag=input;try{synchronized(lock){trace.append('L');${source}}}finally{trace.append('F');if(mode==3)throw FAILURE;}return state+":"+globalFlag+":"+trace;`;
  try{
    let methods='';for(let i=0;i<variants.length;i++){const original=wrap(variants[i][0]),next=simplify(original,{retainDiagnostics:true});assert.ok(next.conditionsSimplified>0,'variant '+i);methods+=`static String old${i}(${parameters}){${original}}\nstatic String next${i}(${parameters}){${next.source}}\nstatic String oracle${i}(${parameters}){${wrap(variants[i][1])}}\n`;}
    const fixture=`public class DominatedPredicates{
      static int state;static volatile int globalFlag;static StringBuilder trace;static final RuntimeException FAILURE=new RuntimeException();
      static Boolean probe(int stage,int mode,Boolean value){trace.append(stage);globalFlag+=7;state++;if(mode==stage+1)throw FAILURE;if(state>2)return Boolean.FALSE;return value;}
      static void hit(){trace.append('T');if(state==1)state+=1;}
      ${methods}
      static String invoke(int kind,int variant,${parameters}){state=0;globalFlag=input;trace=new StringBuilder();try{switch(variant){${variants.map((_,i)=>`case ${i}:return kind==0?old${i}(input,mode,boxed,other,fa,fb,lock):kind==1?next${i}(input,mode,boxed,other,fa,fb,lock):oracle${i}(input,mode,boxed,other,fa,fb,lock);`).join('')}}throw new AssertionError();}catch(Throwable e){if(e==FAILURE)return "failure:"+state+":"+globalFlag+":"+trace;if(e instanceof NullPointerException)return "null:"+state+":"+globalFlag+":"+trace;throw new AssertionError(e);}}
      public static void main(String[]args){Boolean[] values={null,Boolean.FALSE,Boolean.TRUE,new Boolean(false),new Boolean(true)};float[] floats={Float.NaN,-0.0f,0.0f,Float.POSITIVE_INFINITY,Float.NEGATIVE_INFINITY};Object lock=new Object();int count=0;
        for(int v=0;v<10;v++)for(int input:new int[]{-1,0,1,2,7,Integer.MIN_VALUE,Integer.MAX_VALUE})for(Boolean boxed:values)for(Boolean other:values)for(float fa:floats)for(float fb:floats)for(int mode=0;mode<6;mode++){
          Object monitor=mode==4?null:lock;String expected=invoke(2,v,input,mode,boxed,other,fa,fb,monitor);for(int kind=0;kind<2;kind++){String actual=invoke(kind,v,input,mode,boxed,other,fa,fb,monitor);if(!actual.equals(expected))throw new AssertionError(v+":"+input+":"+mode+":"+actual+" != "+expected);if(Thread.holdsLock(lock))throw new AssertionError("monitor leaked");}count++;
        }System.out.println(count+" independent dominated predicate cases");}}
    `;
    const file=path.join(tmp,'DominatedPredicates.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',tmp,file]);assert.equal(run('java',['-Xmx128m','-cp',tmp,'DominatedPredicates']).trim(),'262500 independent dominated predicate cases');
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
