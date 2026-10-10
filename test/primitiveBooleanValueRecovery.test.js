'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {simplifyPredicateNegations:fold}=require('../src/decompiler/javaAstEmitter');
const mode={primitiveValueDoubleNegations:true,complementIntegralRelations:false,retainDiagnostics:true};
test('primitive parameters locals arrays casts and exact owned fields retain value type',()=>{
 const cases=[
  ['Object x=!(!parameter);',{parameters:[{name:'parameter',type:'boolean'}]}],
  ['boolean local=read();Object x=!(!local);',{}],
  ['boolean[] local=read();Object x=!(!local[index()]);',{}],
  ['Object x=!(!(boolean)boxed);',{}],
  ['Object x=!(!this.flag);',{ownedFields:{owner:'Example',fields:[{name:'flag',type:'boolean',static:false}]}}],
  ['Object x=!(!Example.flag);',{ownedFields:{owner:'Example',classQualifierUnshadowed:true,fields:[{name:'flag',type:'boolean',static:true}]}}],
  ['Object x=!(!true);',{}],
 ];
 for(const[source,options]of cases){const result=fold(source,{...mode,...options});assert.equal(result.predicatesSimplified,1,source);assert.equal(result.diagnostics.counts.doubleNegations,1);assert.equal((result.source.match(/!/g)||[]).length,0);let replay=source;for(const e of result.diagnostics.tokenEdits.slice().reverse())replay=replay.slice(0,e.start)+e.text+replay.slice(e.end);assert.equal(replay,result.source);}
});
test('boxed unknown inherited shadowed and out-of-scope operands refuse value simplification',()=>{
 for(const[source,options]of [
  ['Object x=!(!parameter);',{parameters:[{name:'parameter',type:'Boolean'}]}],
  ['Object x=!(!read());',{}],
  ['Object x=!(!Other.flag);',{ownedFields:{owner:'Example',fields:[{name:'flag',type:'boolean',static:true}]}}],
  ['Object x=!(!this.flag);',{ownedFields:{owner:'Example',fields:[]}}],
  ['Object x=!(!Example.flag);',{ownedFields:{owner:'Example',fields:[{name:'flag',type:'boolean',static:true}]}}],
  ['Object Example=read();Object x=!(!Example.flag);',{ownedFields:{owner:'Example',classQualifierUnshadowed:true,fields:[{name:'flag',type:'boolean',static:true}]}}],
  ['{boolean flag=true;}Object x=!(!flag);',{}],
  ['boolean flag=true;{Boolean flag=read();Object x=!(!flag);}',{}],
  ['Object x=!(!parameter);',{parameters:[{name:'parameter',type:'boolean[]'}]}],
 ])assert.equal(fold(source,{...mode,...options}).source,source,source);
 assert.equal(fold('Object x=!(!true);',{primitiveValueDoubleNegations:1}).predicatesSimplified,0);
});
test('default control cleanup stays separate and protected local scope remains precise',()=>{
 const source='boolean value=read();Object x=!(!value);';assert.equal(fold(source).source,source);
 for(const body of ['try{boolean value=read();Object x=!(!value);}finally{cleanup();}',
  'synchronized(lock){boolean value=read();Object x=!(!value);}',
  'try{work();}catch(Exception e){boolean value=read();Object x=!(!value);}']){
  assert.equal(fold(body,mode).predicatesSimplified,1,body);
 }
});
test('native primitive value copies preserve boxing dispatch volatile reads indexes and protection',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'primitive-boolean-native-'));
 const run=(command,args)=>{const outputs=['out','err'].map(n=>path.join(directory,n)),fds=outputs.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(outputs[1],'utf8'));return fs.readFileSync(outputs[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const bodies=['Object result=choose(!(!value));',
  'boolean local=step();Object result=choose(!(!local));',
  'Object result=choose(!(!this.stateFlag));',
  'boolean[] local={value};Object result=choose(!(!local[index()]));'];
 const oracles=['boolean copy=value;Object result=choose(copy);','boolean copy=step();Object result=choose(copy);','boolean copy=this.stateFlag;Object result=choose(copy);','boolean[] local={value};int position=index();boolean copy=local[position];Object result=choose(copy);'];
 const wraps=[s=>s,s=>`try{${s}}finally{event(4);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`];
 try{let methods='',models=0;
  for(let kind=0;kind<bodies.length;kind++)for(const wrap of wraps){const tail='selected=result==Boolean.TRUE;canonical=result==Boolean.TRUE||result==Boolean.FALSE;event(5);',before=wrap(bodies[kind]+tail)+'return snapshot();',next=fold(before,{...mode,parameters:[{name:'value',type:'boolean'}],ownedFields:{owner:'BooleanValueOracle',fields:[{name:'stateFlag',type:'boolean',static:false}]}});assert.equal(next.predicatesSimplified,1,before);for(const[name,source]of [['old',before],['next',next.source],['oracle',wrap(oracles[kind]+tail)+'return snapshot();']])methods+=`String ${name}${models}(boolean value,int mode){${source}}\n`;models++;}
  const java=`public class BooleanValueOracle{
   static int count,failAt,arrayIndex;static boolean selected,canonical;static Object lock;static StringBuilder trace;volatile boolean stateFlag;
   static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
   static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}
   boolean step(){event(1);boolean copy=stateFlag;stateFlag=!stateFlag;return copy;}static int index(){event(2);return arrayIndex;}
   static Object choose(boolean b){event(3);return b?Boolean.TRUE:Boolean.FALSE;}static Object choose(Boolean b){event(6);return b;}
   static String snapshot(){return count+":"+selected+":"+canonical+":"+trace;}
   ${methods}
   static String take(int model,int variant,boolean value,boolean field,int mode){count=0;selected=false;canonical=false;lock=new Object();trace=new StringBuilder();BooleanValueOracle object=new BooleanValueOracle();object.stateFlag=field;String result;try{switch(model){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?object.old${i}(value,mode):variant==1?object.next${i}(value,mode):object.oracle${i}(value,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot()+":"+object.stateFlag;}
   public static void main(String[]args){int cases=0;for(int model=0;model<${models};model++)for(boolean value:new boolean[]{false,true})for(boolean field:new boolean[]{false,true})for(arrayIndex=-1;arrayIndex<2;arrayIndex++)for(int mode=0;mode<3;mode++)for(failAt=-1;failAt<8;failAt++){String expected=take(model,2,value,field,mode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,value,field,mode);if(!actual.equals(expected))throw new AssertionError(model+":"+value+":"+field+":"+arrayIndex+":"+mode+":"+failAt+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
  `;const file=path.join(directory,'BooleanValueOracle.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'BooleanValueOracle']),'3888');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
