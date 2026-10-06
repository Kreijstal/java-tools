'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
const{foldNestedIfConditions:fold,simplifyPredicateGrouping:group}=require('../src/decompiler/javaAstEmitter');
test('maximal sole-if chains become ordered conjunctions while keeping the deepest body',()=>{
 const source='before();if(a){if(b){if(c){work();}}}after();',next=fold(source,{retainDiagnostics:true});assert.equal(next.source,'before();if ((a) && (b) && (c)) {work();}after();');assert.equal(next.ifsMerged,2);assert.equal(next.conditionsJoined,3);assert.equal(fold(next.source).ifsMerged,0);
 assert.equal(fold('if(a){if(b)work();}').source,'if ((a) && (b)) work();');
 const multiline='if(a) {\n  if(b) {\n    before();\n    work();\n  }\n}';assert.equal(fold(multiline).source,'if ((a) && (b)) {\n  before();\n  work();\n}');
});
test('normal emission merges a complete chain after prior control reconstruction',()=>{
 const body=['Frame:{if(first())break Frame;if(second())break Frame;work();}'];finish(body);assert.equal(body[0],'if ((!first()) && (!second())) {work();}');
});
test('conditions preserve identity, calls, assignments, arithmetic association and protected bodies',()=>{
 const source='if(a||read()){if((boxed==other)&&probe()){try{synchronized(lock){work();}}finally{cleanup();}}}';
 const next=fold(source);assert.equal(next.ifsMerged,1);assert.ok(next.source.includes('(a||read()) && ((boxed==other)&&probe())'));assert.ok(next.source.includes('try{synchronized(lock){work();}}finally{cleanup();}'));
 const scope='if(first()){if(second()){int value=read();work(value);}}';assert.ok(fold(scope).source.endsWith('{int value=read();work(value);}'));
});
test('else arms, intervening actions/declarations, unsupported executables and budgets refuse',()=>{
 for(const source of ['if(a){if(b)yes();else no();}','if(a){if(b)work();}else other();','if(a){before();if(b)work();}','if(a){int x=0;if(b)work();}','if(a){try{if(b)work();}finally{cleanup();}}','if(a){if(b)work();}//comment\n','if(a){if(b)work();}\\u000a','if(a){if(b)work();}Runnable r=()->run();','if(a){if(b)work();}class Nested{}','if(a){if(b)work();}'+' '.repeat(400001)])assert.equal(fold(source).source,source,source.slice(0,70));
 const long='if(a){'.repeat(33)+'work();'+'}'.repeat(33);assert.equal(fold(long).ifsMerged,0);
});
test('original lexical transfers retain their nearest loop/switch/label and scalar else attachment',()=>{
 const source='Outer:while(run()){if(a){if(b){if(c)break Outer;continue;}}switch(key){case 1:if(a){if(b){break;}}break;default:break;}}';const first=fold(source),next=fold(first.source);assert.equal(first.ifsMerged,1);assert.equal(next.ifsMerged,1);assert.ok(next.source.includes('if(c)break Outer;continue;'));assert.ok(next.source.includes('case 1:if ((a) && (b)) {break;}'));
 assert.equal(fold('if(parent){if(a){if(b)work();}}else other();').source,'if(parent){if ((a) && (b)) work();}else other();');
});
test('diagnostics retain conditions and body exactly once without new identifiers or actions',()=>{
 const source='if((a||b)){if(read(c)){work(d);}}',next=fold(source,{retainDiagnostics:true}),d=next.diagnostics;assert.equal(d.controls.length,2);assert.deepEqual(d.controls.map(c=>source.slice(c.conditionRange.start,c.conditionRange.end)),['((a||b))','(read(c))']);assert.equal(source.slice(d.bodyRange.start,d.bodyRange.end),'{work(d);}');let expected=d.segments.map(s=>s.text??source.slice(s.range.start,s.range.end)).join('');assert.equal(next.source,expected);assert.equal(d.segments.filter(s=>s.range?.start===d.bodyRange.start).length,1);assert.ok(!Object.hasOwn(fold(source),'diagnostics'));
});
test('native chains match independent ordered oracles through nullable boxing, NaNs, identity and protected completion',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nested-if-native-'));
 const run=(cmd,args)=>{const out=path.join(directory,'out'),err=path.join(directory,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const contexts=[s=>s,s=>`try{${s}}finally{event(7);if(mode==1)return snap(result);if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){event(6);${s}}`,s=>`try{${s}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(7);}`,s=>`try{synchronized(lock){event(6);${s}}}finally{event(7);if(mode==1)return snap(result);if(mode==2)throw OVERRIDE;}`,s=>`{Object alias=lock;${s}if(alias!=lock)throw new AssertionError();}`];
 const predicates=['probe(a,0,inject)','!(!probe(b,1,inject))','probe(c,2,inject)&&(left==right)','floating<0.0f||probe(d,3,inject)'];
 try{let methods='',models=0;for(const protect of contexts)for(let levels=2;levels<=4;levels++){
  const leaf='{int saved=counter;event(5);result=saved!=counter;}',nested=predicates.slice(0,levels).map(p=>'if('+p+'){').join('')+leaf+'}'.repeat(levels);
  const source='boolean result=false;'+protect(nested+'event(9);')+'return snap(result);',next=fold(source);assert.equal(next.ifsMerged,levels-1);const clean=group(next.source);assert.equal(fold(next.source).ifsMerged,0);
  const decision='boolean selected=probe(a,0,inject);if(selected)selected=probe(b,1,inject);'+(levels>=3?'if(selected){boolean third=probe(c,2,inject);selected=third&&left==right;}':'')+(levels>=4?'if(selected){if(floating<0.0f)selected=true;else selected=probe(d,3,inject);}':'');
  const oracle='boolean result=false;'+protect(decision+'if(selected)'+leaf+'event(9);')+'return snap(result);';
  for(const[name,body]of [['old',source],['next',next.source],['clean',clean.source],['oracle',oracle]])methods+=`static String ${name}${models}(Boolean a,Boolean b,Boolean c,Boolean d,Object left,Object right,float floating,int inject,int mode){${body}}\n`;models++;
 }
 const java=`public class NestedIfNative{static int counter;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){counter=counter*31+n;trace.append((char)('a'+n));}static Boolean probe(Boolean b,int stage,int inject){event(stage);if(inject==stage)throw FAILURE;return b;}static String snap(boolean result){return result+":"+counter+":"+trace;}
${methods}
static String take(int kind,int variant,Boolean a,Boolean b,Boolean c,Boolean d,Object left,Object right,float floating,int seed,int inject,int mode,boolean nullLock){counter=seed;trace=new StringBuilder();lock=nullLock?null:new Object();String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(a,b,c,d,left,right,floating,inject,mode):variant==1?next${i}(a,b,c,d,left,right,floating,inject,mode):variant==2?clean${i}(a,b,c,d,left,right,floating,inject,mode):oracle${i}(a,b,c,d,left,right,floating,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+counter+":"+trace;}
public static void main(String[]args){int cases=0;Object first=new Object(),second=new Object();Object[][]refs={{first,first},{first,second},{null,null}};for(int kind=0;kind<${models};kind++)for(Boolean a:new Boolean[]{false,true,null})for(Boolean b:new Boolean[]{false,true,null})for(Boolean c:new Boolean[]{false,true,null})for(Boolean d:new Boolean[]{false,true,null})for(Object[]ref:refs)for(float floating:new float[]{Float.NaN,-0.0f,0.0f,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int inject=0;inject<5;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true}){String expected=take(kind,3,a,b,c,d,ref[0],ref[1],floating,seed,inject,mode,nullLock);for(int variant=0;variant<3;variant++)if(!take(kind,variant,a,b,c,d,ref[0],ref[1],floating,seed,inject,mode,nullLock).equals(expected))throw new AssertionError(kind+":"+variant+":"+inject);cases++;}System.out.println(cases+" cases, ${models} models");}}
`;fs.writeFileSync(path.join(directory,'NestedIfNative.java'),java);run('javac',['-d',directory,path.join(directory,'NestedIfNative.java')]);assert.equal(run('java',['-Xmx128m','-cp',directory,'NestedIfNative']),'3280500 cases, 18 models');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
