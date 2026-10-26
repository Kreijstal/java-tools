'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), {spawnSync} = require('child_process');
const {recoverBooleanLocalRepresentations: recover} = require('../src/decompiler/javaAstEmitter');

test('recovers Boolean snapshots, copies, eager operators and equality without naming assumptions', () => {
  const source='int available=(probe()?1:0);int retained=available;int enabled=0;enabled=retained & (next()?0:1);if((enabled ^ retained)!=0)hit();';
  const result=recover(source);
  assert.equal(result.localsPromoted,3);assert.equal(result.comparisonsRecovered,1);assert.equal(result.selectionsRecovered,2);
  assert.equal(result.source,'boolean available=((probe()));boolean retained=available;boolean enabled=false;enabled=retained & (!(next()));if(((enabled ^ retained)))hit();');
  assert.equal(recover(result.source).source,result.source);
});

test('retains selection tests when both arms have the same bit', () => {
  const source='int x=probe()?0:0;int y=other()?1:1;if(x!=y)hit();';
  const result=recover(source);assert.equal(result.localsPromoted,2);assert.equal(result.selectionsRecovered,0);
  assert.equal(result.source,'boolean x=probe()?false:false;boolean y=other()?true:true;if((x != y))hit();');
});

test('preserves blank finals, grouped declarations, switches, loops, handlers and monitors', () => {
  const decision='int x=0,y=1;final int z;try{synchronized(lock){for(int i=0;i<3;i++){x=y^x;}switch(mode){case 1:z=x|y;break;default:z=x&y;}}}catch(Failure failure){throw failure;}finally{if(x==0)done();}return z==1;';
  const result=recover(decision);assert.equal(result.localsPromoted,3);assert.equal(result.comparisonsRecovered,2);
  assert.ok(result.source.includes('boolean x=false,y=true;final boolean z;'));
  assert.ok(result.source.includes('for(int i=0;i<3;i++)'));assert.ok(result.source.includes('x=y^x;'));
  assert.equal(recover(result.source).source,result.source);
});

for(const observer of ['sink(copy);','return copy;','Object boxed=copy;','float widened=copy;',
  'copy++;','copy+=1;','copy=read();','copy=2;','int[] values=new int[copy];','switch(copy){default:break;}',
  'if(copy<1)hit();','if(copy==2)hit();','if(copy==0L)hit();','this.field=copy;',
  'array[0]=copy;','int value=copy+1;','if((copy=read())==0)hit();']) {
  test('numeric observer rejects the connected representation: '+observer,()=>{
    const source='int original=probe()?1:0;int copy=original;int result=copy&original;if(result!=0)hit();'+observer;
    assert.equal(recover(source).source,source);
  });
}

test('independent safe components still recover beside numeric or unused locals',()=>{
  const source='int numeric=read();int a=probe()?1:0;if(a==1)hit();sink(numeric);';
  assert.equal(recover(source).localsPromoted,1);
  for(const source of ['int a=0,unused=1;if(a!=0)hit();','int a=0,b=read();if(a!=0)hit();sink(b);','int unused=0;'])assert.equal(recover(source).source,source);
  const mixed='int numeric=read();int flag=(numeric!=0)?1:0;int value=(flag==0)?20:30;sink(value);';
  const result=recover(mixed);assert.equal(result.localsPromoted,1);assert.equal(result.source,'int numeric=read();boolean flag=(numeric!=0);int value=((!(flag)))?20:30;sink(value);');
});

test('many independent networks preserve order and type rather than relying on a slot-name convention',()=>{
  const source=Array.from({length:500},(_,index)=>`int local${index}=probe(${index})?1:0;if(local${index}!=0)hit(${index});`).join('\n');
  const result=recover(source);assert.equal(result.localsPromoted,500);assert.equal(result.comparisonsRecovered,500);assert.equal(result.selectionsRecovered,500);
  assert.equal(recover(result.source).source,result.source);
});

test('default source and method-body policy applies the same closed-network proof',()=>{
  const {simplifyBodyDecisions:body,simplifyCompilationUnitDecisions:unit}=require('../src/decompiler/javaAstEmitter');
  const source='int flag=probe()?1:0;int copy=flag;if((copy^flag)!=0)hit();';
  const result=body(source);assert.equal(result.booleanLocalsPromoted,2);assert.equal(result.booleanSelectionsRecovered,1);
  assert.ok(result.source.includes('boolean flag'));assert.ok(!result.source.includes('?'));assert.ok(!result.source.includes('!=0'));
  assert.equal(body(result.source).source,result.source);
  const file='class Flags{void run(){'+source+'}}';
  const changed=unit(file);assert.equal(changed.booleanLocalsPromoted,2);assert.equal(changed.bodiesSimplified,1);assert.equal(unit(changed.source).source,changed.source);
});

test('refuses shadowed identities, captures, ambiguous token names and unsupported offsets',()=>{
  const base='int flag=probe()?1:0;if(flag!=0)hit();';
  for(const source of [base+'{int flag=0;}',base+'Runnable r=()->hit();',base+'Object r=new Object(){};',
    base+'class Local{}',base+'Runnable r=Owner::run;',base+' /* keep */',base+'\\u000a',
    '{int flag=0;}if(flag!=0)hit();','if(flag!=0)hit();'+base,base+'this.flag=0;',base+'flag();',
    'int[] flag=null;if(flag!=null)hit();',base+' '.repeat(400001)])assert.equal(recover(source).source,source);
  assert.equal(recover(base,{reservedNames:['flag']}).source,base);
});

function run(command,args,cwd){const result=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(result.status,0,result.stderr||result.error?.stack||result.stdout);return result.stdout.trim();}

test('default bytecode roundtrip retains flag snapshots and native call traces',()=>{
  const {decompileClassFile}=require('../src/decompiler/cfr');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'boolean-representation-default-'));
  try{
    const original=path.join(temporary,'original'),next=path.join(temporary,'next');fs.mkdirSync(original);fs.mkdirSync(next);
    const source=`class BooleanRepresentationDefault{
      static int calls;static boolean shared;static boolean probe(boolean flag){calls++;shared=!shared;return flag;}
      static boolean choose(boolean left,boolean right){int first=probe(left)?1:0;int second=probe(right)?0:1;int result=first&(probe(right)?1:0);int saved=result;result=second^first;return ((saved|result)!=0)&&shared;}
      public static void main(String[]args){for(boolean left:new boolean[]{false,true})for(boolean right:new boolean[]{false,true}){calls=0;shared=false;System.out.println(choose(left,right)+":"+calls+":"+shared);}}
    }`;
    fs.writeFileSync(path.join(original,'BooleanRepresentationDefault.java'),source);run('javac',['--release','8','BooleanRepresentationDefault.java'],original);
    const diagnostics=[],output=decompileClassFile(path.join(original,'BooleanRepresentationDefault.class'),{diagnostics});assert.deepEqual(diagnostics,[]);
    assert.match(output,/boolean (?:var|stackIn_)/);assert.doesNotMatch(output,/switch\s*\(statePc\)/);
    fs.writeFileSync(path.join(next,'BooleanRepresentationDefault.java'),output);run('javac',['--release','8','BooleanRepresentationDefault.java'],next);
    assert.equal(run('java',['-Xverify:all','-cp',next,'BooleanRepresentationDefault'],next),run('java',['-Xverify:all','-cp',original,'BooleanRepresentationDefault'],original));
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('native three-way traces preserve snapshots, eager tests, unboxing, protected completion and floating predicates',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'boolean-representation-native-'));
  const wraps=[s=>s,s=>`synchronized(lock){trace.append('L');${s}}`,
    s=>`try{${s}}finally{trace.append('F');if(mode==1)return false;if(mode==2)throw OVERRIDE;}`,
    s=>`try{synchronized(lock){trace.append('L');${s}}}catch(IllegalStateException failure){if(failure!=FAILURE)throw failure;trace.append('C');}finally{trace.append('F');}`];
  try{
    let methods='',dispatch='';
    for(const [index,wrap]of wraps.entries()){
      const decisions=`for(int i=0;i<2;i++){a=probe(0,left,inject)?1:0;b=probe(1,right,inject)?0:1;int saved=a;c=a & (probe(2,right,inject)?1:0);if(mode==3){c=saved^b;}int frozen=shared?1:0;shared=!shared;int floatTest=(number<0.0)?1:0;int same=probe(3,left,inject)?0:0;if(same==0)trace.append('S');trace.append(tag((c|b)!=0)).append(tag(frozen==0)).append(tag(floatTest!=0));}return c==1;`;
      const source='int a=0,b=0,c=0;'+wrap(decisions)+'return false;';
      // The trailing return is needed only when the catch or overriding
      // finally can finish normally. Keep the other variants compilable.
      const old=index===3?source:source.slice(0,-'return false;'.length);
      const next=recover(old);assert.equal(next.localsPromoted,7);assert.equal(next.comparisonsRecovered,5);assert.equal(next.selectionsRecovered,5);
      const oracleDecisions=`for(int i=0;i<2;i++){a=probe(0,left,inject).booleanValue();b=!probe(1,right,inject).booleanValue();boolean saved=a;c=a & probe(2,right,inject).booleanValue();if(mode==3){c=saved^b;}boolean frozen=shared;shared=!shared;boolean floatTest=number<0.0;boolean same=probe(3,left,inject).booleanValue()?false:false;if(!same)trace.append('S');trace.append(tag(c|b)).append(tag(!frozen)).append(tag(floatTest));}return c;`;
      const oracle='boolean a=false,b=false,c=false;'+wrap(oracleDecisions)+(index===3?'return false;':'');
      for(const [name,body]of [['old',old],['next',next.source],['oracle',oracle]])methods+=`static boolean ${name}${index}(Boolean left,Boolean right,int inject,int mode,Object lock,double number){${body}}\n`;
      dispatch+=`case ${index}:return variant==0?old${index}(left,right,inject,mode,lock,number):variant==1?next${index}(left,right,inject,mode,lock,number):oracle${index}(left,right,inject,mode,lock,number);`;
    }
    const fixture=`class BooleanRepresentationNative{
      static StringBuilder trace;static boolean shared;static final RuntimeException FAILURE=new IllegalStateException("probe"),OVERRIDE=new IllegalArgumentException("finally");
      static Boolean probe(int stage,Boolean flag,int inject){trace.append(stage);if(inject==stage)throw FAILURE;return flag;}
      static String tag(boolean b){return b?"T":"F";}
      static String tag(Boolean b){throw new AssertionError("boxed overload");}static String tag(Object b){throw new AssertionError("reference overload");}static String tag(int b){throw new AssertionError("numeric overload");}
      ${methods}
      static boolean call(int context,int variant,Boolean left,Boolean right,int inject,int mode,Object lock,double number){switch(context){${dispatch}default:throw new AssertionError();}}
      static String take(int context,int variant,Boolean left,Boolean right,int inject,int mode,Object lock,double number,boolean initial){trace=new StringBuilder();shared=initial;String result;try{result=tag(call(context,variant,left,right,inject,mode,lock,number));}catch(Throwable failure){result=failure==FAILURE?"probe":failure==OVERRIDE?"finally":failure.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("leaked lock");return result+":"+shared+":"+trace;}
      public static void main(String[]args){int cases=0;for(int context=0;context<4;context++)for(Boolean left:new Boolean[]{false,true,null})for(Boolean right:new Boolean[]{false,true,null})for(int inject=-1;inject<4;inject++)for(int mode=0;mode<4;mode++)for(Object lock:new Object[]{null,new Object()})for(double number:new double[]{Double.NaN,Double.NEGATIVE_INFINITY,-1.0,-0.0,0.0,Double.POSITIVE_INFINITY})for(boolean initial:new boolean[]{false,true}){String expected=take(context,2,left,right,inject,mode,lock,number,initial);for(int variant=0;variant<2;variant++){String actual=take(context,variant,left,right,inject,mode,lock,number,initial);if(!expected.equals(actual))throw new AssertionError(context+":"+variant+":"+left+":"+right+":"+inject+":"+mode+":"+expected+" != "+actual);}cases++;}System.out.println("cases:"+cases);}
    }`;
    fs.writeFileSync(path.join(temporary,'BooleanRepresentationNative.java'),fixture);
    run('javac',['--release','8','BooleanRepresentationNative.java'],temporary);
    assert.equal(run('java',['-Xverify:all','-XX:-OmitStackTraceInFastThrow','-cp',temporary,'BooleanRepresentationNative'],temporary),'cases:17280');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
