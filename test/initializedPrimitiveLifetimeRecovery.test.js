'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{splitInitializedPrimitiveLocalLifetimes:split}=require('../src/decompiler/primitiveLocalLifetimeRecovery');

test('retains literal initializers and primitive widths while separating independently assigned phases',()=>{
 for(const[type,value]of[['boolean','true'],['byte','-1'],['short','0'],['char',"'a'"],['int','-2147483648'],['long','-9223372036854775808L'],['float','-0.0f'],['double','-0.0']]){
  const s=`${type} x=${value};use(x);x=first();use(x);x=second();use(x);`,r=split(s,{retainDiagnostics:true});assert.equal(r.localsSplit,1,type);assert.equal(r.declarationsAdded,2);assert.ok(r.source.startsWith(`${type} x=${value};`));assert.equal(r.diagnostics.locals[0].initialized,true);assert.equal(r.diagnostics.locals[0].type,type);assert.equal(split(r.source).localsSplit,0);
 }
 assert.equal(split('int x=read();use(x);x=first();use(x);x=second();use(x);').localsSplit,0);
});
test('protected containers preserve literal snapshots and refuse handler or finally reaching values',()=>{
 for(const protect of[s=>`try{${s}}catch(RuntimeException e){handle(e);}finally{finish();}`,s=>`synchronized(lock){${s}}`]){
  const r=split('int x=0;'+protect('use(x);x=first();use(x);x=second();use(x);'));assert.equal(r.declarationsAdded,2);
 }
 for(const s of['int x=0;try{x=first();use(x);x=second();use(x);}finally{use(x);}','int x=0;try{x=first();use(x);x=second();use(x);}catch(RuntimeException e){use(x);}','int x=0;use(x);synchronized(lock){x=first();use(x);}x=second();use(x);'])assert.equal(split(s).source,s);
});
test('loop carries, conditional resets, captures and ambiguous identifiers remain in their original phase',()=>{
 for(const s of['int x=0;while(next()){use(x);x=second();use(x);}','int x=0;while(next()){if(flag)use(x);x=second();use(x);}','int x=0;x=first();if(flag)x=second();use(x);','int x=0;use(x);x=first();use(this.x+x);x=second();use(x);','int x=0;use(x);x=first();use(x);Runnable r=()->use(x);x=second();use(x);','int x=0;use(x);x=first();use(x);// keep\n'])assert.equal(split(s).source,s);
 assert.match(split('int x=0;use(x);x=first();use(x);',{reservedNames:['xLifetime1']}).source,/int xLifetime2;/);
});
test('native literal phases preserve snapshots, overflows, floating bits, cleanup and partial effects',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'initialized-primitives-native-'));
 const run=(cmd,args)=>{const out=path.join(dir,'out'),err=path.join(dir,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const body='event(x);x=seed;event(x);x=seed+7;event(x);event(wide);wide=Long.MAX_VALUE+seed;event(wide);wide=Long.MIN_VALUE-seed;event(wide);event(Float.floatToRawIntBits(fraction));fraction=Float.intBitsToFloat(bits);event(Float.floatToRawIntBits(fraction));fraction=Float.intBitsToFloat(bits)*1.0f;event(Float.floatToRawIntBits(fraction));event(chosen?1:0);chosen=flag;event(chosen?1:0);chosen=!flag;event(chosen?1:0);event(symbol);symbol=(char)seed;event(symbol);symbol=(char)(seed+1);event(symbol);';
 const oracle='event(0);event(seed);event(seed+7);event(0L);event(Long.MAX_VALUE+seed);event(Long.MIN_VALUE-seed);event(0x80000000);event(Float.floatToRawIntBits(Float.intBitsToFloat(bits)));event(Float.floatToRawIntBits(Float.intBitsToFloat(bits)*1.0f));event(0);event(flag?1:0);event(flag?0:1);event(97);event((char)seed);event((char)(seed+1));';
 const protects=[s=>s,s=>`try{${s}}finally{event(991);if(mode==1)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{${s}}catch(IllegalStateException e){event(992);if(e!=FAILURE)throw e;}finally{event(991);}`];
 try{let methods='';for(let i=0;i<protects.length;i++){const src='int x=0;long wide=0L;float fraction=-0.0f;boolean chosen=false;char symbol=\'a\';'+protects[i](body)+'return snapshot();',r=split(src);assert.equal(r.localsSplit,5);assert.equal(r.declarationsAdded,10);for(const[name,code]of[['old',src],['next',r.source],['oracle',protects[i](oracle)+'return snapshot();']])methods+=`static String ${name}${i}(int seed,int bits,boolean flag,int mode){${code}}\n`;}
 const java=`public class InitializedPhases{static long state;static int count,failAt;static Object lock;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(long v){state=state*31+v;state=state*31+(Thread.holdsLock(lock)?1:0);if(count++==failAt)throw FAILURE;}static String snapshot(){return state+":"+count;}${methods}
 static String take(int kind,int variant,int seed,int bits,boolean flag,int mode){state=count=0;lock=new Object();String result;try{switch(kind){${protects.map((_,i)=>`case ${i}:result=variant==0?old${i}(seed,bits,flag,mode):variant==1?next${i}(seed,bits,flag,mode):oracle${i}(seed,bits,flag,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("monitor retained");return result+":"+snapshot();}
 public static void main(String[]args){int cases=0;for(int kind=0;kind<${protects.length};kind++)for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,7,Integer.MAX_VALUE})for(int bits:new int[]{0,0x80000000,0x3f800000,0x7f800000,0xff800000,0x7fc00001,0x7f800001,1})for(boolean flag:new boolean[]{false,true})for(int mode=0;mode<2;mode++)for(int failure=-1;failure<20;failure++){failAt=failure;String expected=take(kind,2,seed,bits,flag,mode);for(int variant=0;variant<2;variant++)if(!expected.equals(take(kind,variant,seed,bits,flag,mode)))throw new AssertionError(kind+":"+variant+":"+seed+":"+bits+":"+failure+":"+expected);cases++;}System.out.println(cases);}}
 `;fs.writeFileSync(path.join(dir,'InitializedPhases.java'),java);run('javac',['--release','8','-d',dir,path.join(dir,'InitializedPhases.java')]);assert.equal(run('java',['-Xmx128m','-cp',dir,'InitializedPhases']),'16128');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
