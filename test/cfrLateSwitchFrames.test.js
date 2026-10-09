'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
const action=n=>`event(${n+1});if(flag==0)break Phase;`;
const ladder='if(selected!=0){if(selected!=1){if(selected!=2){if(selected==3){'+action(3)+'}if(selected!=4){if(selected!=5){if(6==selected){'+action(6)+'}if(selected!=7){break Phase;}'+action(7)+'}'+action(5)+'}'+action(4)+'}'+action(2)+'}'+action(1)+'}'+action(0);
const source='int selected=key;Phase:{event(0);if(enabled){event(9);'+ladder+'}}event(10);return state;';
const fold=source=>{const body=source.split('\n');const parameters=[{name:'key',type:'int'},{name:'flag',type:'int'},{name:'enabled',type:'boolean'},{name:'mode',type:'int'},{name:'lock',type:'Object'}];finish(body,parameters.map(p=>p.name),parameters);return body.join('\n');};

test('late dispatch finishes its newly exposed terminal switch in the real emitter pipeline',()=>{
  const next=fold(source);assert.match(next,/switch \(selected\)/);assert.doesNotMatch(next,/Phase:|break Phase/);
  for(let stage=0;stage<=10;stage++)assert.equal((next.match(new RegExp('event\\('+stage+'\\)','g'))||[]).length,1,'each original action has one source occurrence');
  assert.ok(next.includes('int selected=key;'));assert.ok(next.includes('if(flag==0)break;'));
});

test('late switch completion retains work, intervening protection and declaration scopes',()=>{
  const suffix=source.replace('}}event(10);','}event(13);}event(10);');assert.match(fold(suffix),/break Phase/);
  const protectedSuffix=source.replace('Phase:{event(0);','Phase:{try{event(0);').replace('}}event(10);','}}finally{event(13);}event(14);}event(10);');assert.match(fold(protectedSuffix),/break Phase/);
  const scoped=source.replace('int selected=key;Phase:{','Phase:{int selected=key;');const next=fold(scoped);assert.doesNotMatch(next,/Phase:|break Phase/);assert.match(next,/\{int selected=key;/);
});

test('late emitter completion matches an independent native action dispatcher',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'late-switch-pipeline-native-'));
  const wraps=[s=>s,s=>`try{${s}}catch(IllegalStateException failure){event(11);throw failure;}finally{event(12);}`,
    s=>`synchronized(lock){${s}}`,s=>`try{synchronized(lock){${s}}}finally{event(12);if(mode==1)return state;if(mode==2)throw OVERRIDE;}`];
  const oracle='event(0);if(enabled){event(9);int[] steps;switch(key){case 0:steps=new int[]{1};break;case 1:steps=new int[]{2,1};break;case 2:steps=new int[]{3,2,1};break;case 3:steps=new int[]{4};break;case 4:steps=new int[]{5,3,2,1};break;case 5:steps=new int[]{6,5,3,2,1};break;case 6:steps=new int[]{7};break;case 7:steps=new int[]{8,6,5,3,2,1};break;default:steps=new int[0];}for(int stage:steps){event(stage);if(flag==0)break;}}event(10);return state;';
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr||result.stdout);return result.stdout.trim();};
  try{
    const methods=wraps.flatMap((wrap,index)=>{const old='int selected=key;'+wrap(source.slice('int selected=key;'.length)),next=fold(old);assert.doesNotMatch(next,/Phase:|break Phase/);return [`static int old${index}(int key,int flag,boolean enabled,int mode,Object lock){${old}}`,`static int next${index}(int key,int flag,boolean enabled,int mode,Object lock){${next}}`,`static int oracle${index}(int key,int flag,boolean enabled,int mode,Object lock){${wrap(oracle)}}`];}).join('\n');
    const fixture=`public class LateSwitchPipelineNative {
static final RuntimeException FAILURE=new IllegalStateException("injected"),OVERRIDE=new IllegalStateException("finally");
static int state,fail;static StringBuilder trace;
static void event(int stage){trace.append((char)('a'+stage));state=state*31+stage;if(stage==fail)throw FAILURE;}
${methods}
static String take(int context,int variant,int key,int flag,boolean enabled,int mode,int seed,int injection,Object lock){state=seed;fail=injection;trace=new StringBuilder();String result;try{switch(context){${wraps.map((_,i)=>`case ${i}:result=Integer.toString(variant==0?old${i}(key,flag,enabled,mode,lock):variant==1?next${i}(key,flag,enabled,mode,lock):oracle${i}(key,flag,enabled,mode,lock));break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){result=failure==FAILURE?"failure":failure==OVERRIDE?"override":failure.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+state+":"+trace;}
public static void main(String[] args){int cases=0;for(int context=0;context<4;context++)for(int key:new int[]{-1,0,1,2,3,4,5,6,7,Integer.MIN_VALUE,Integer.MAX_VALUE})for(int flag:new int[]{-1,0,1})for(boolean enabled:new boolean[]{false,true})for(int mode=0;mode<3;mode++)for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE})for(int injection=-1;injection<=12;injection++)for(Object lock:new Object[]{null,new Object()}){String want=take(context,2,key,flag,enabled,mode,seed,injection,lock);for(int variant=0;variant<2;variant++){String got=take(context,variant,key,flag,enabled,mode,seed,injection,lock);if(!want.equals(got))throw new AssertionError(context+":"+variant+":"+key+":"+flag+":"+enabled+":"+mode+":"+seed+":"+injection+"\\n"+want+"\\n"+got);}cases++;}System.out.println(cases+" independent cases / 4 contexts");}}
`;
    const file=path.join(temporary,'LateSwitchPipelineNative.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);assert.equal(run('java',['-XX:-OmitStackTraceInFastThrow','-Xmx128m','-cp',temporary,'LateSwitchPipelineNative']),'66528 independent cases / 4 contexts');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
