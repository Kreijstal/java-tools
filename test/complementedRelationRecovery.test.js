'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {simplifyComplementedRelations:fold}=require('../src/decompiler/javaAstEmitter');
const {shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
test('relational order reverses while original operands, casts and parentheses remain',()=>{
 for(const [op,next]of [['<','>'],['<=','>='],['>','<'],['>=','<=']]){const result=fold(`return (~left()) ${op} (~right[index()]);`,{retainDiagnostics:true});assert.equal(result.source,`return (left()) ${next} (right[index()]);`);assert.equal(result.comparisonsSimplified,1);assert.equal(result.complementsRemoved,2);assert.equal(result.diagnostics.edits.length,3);assert.equal(fold(result.source).comparisonsSimplified,0);}
 assert.equal(fold('return ~((int)left()) < ~(right >> shift());').source,'return ((int)left()) > (right >> shift());');
});
test('complete parsed ASTs certify nested calls, array indices and expression association',()=>{
 const source='output=call(~a<~b,(~get(~c>=~d))<=~array[(~e>~f)?0:1]);';const n=fold(source);assert.equal(n.comparisonsSimplified,4);assert.equal(n.source,'output=call(a>b,(get(c<=d))>=array[(e<f)?0:1]);');
 for(const source of ['return ~a+~b<~c;','return ~(a+b)<~(c*d);','return (~a)<(~b+1);']){const n=fold(source);if(source.includes('~(a+b)'))assert.equal(n.source,'return (a+b)>(c*d);');else assert.equal(n.comparisonsSimplified,0);}
});
test('boxed equality, single complements, comments, executables, unicode and budgets refuse',()=>{
 for(const source of ['return ~left==~right;','return ~left!=~right;','return ~left<right;','return left<~right;','return ~a<~b;//note\n','return ~a<~b;\\u000a','return ~a<~b;Runnable r=()->run();','return ~a<~b;Object r=obj::method;','return ~a<~b;class Nested{}','return ~a<~b;'+' '.repeat(400001)])assert.equal(fold(source).comparisonsSimplified,0,source.slice(0,60));
 const many='sink(~a<~b);'.repeat(513);assert.equal(fold(many).comparisonsSimplified,0);
});
test('normal emission normalizes loop, return and control comparisons',()=>{
 const body=['while (~index < ~size) { index++; } return (~left) >= (~right);'];finish(body);assert.equal(body[0],'while (index > size) { index++; } return (left) <= (right);');
 const nested=['return ~(~left()) < ~(~right());'];finish(nested);assert.equal(nested[0],'return (left()) < (right());');
});
test('diagnostics remove only the two tilde tokens and reverse the original relation',()=>{
 const source='try{if(~first()<=~second()){work();}}finally{cleanup();}',n=fold(source,{retainDiagnostics:true});const s=n.diagnostics.selections[0];assert.equal(source.slice(s.leftComplementRange.start,s.leftComplementRange.end),'~');assert.equal(source.slice(s.rightComplementRange.start,s.rightComplementRange.end),'~');assert.equal(source.slice(s.operatorRange.start,s.operatorRange.end),'<=');assert.equal(n.source,'try{if(first()>=second()){work();}}finally{cleanup();}');assert.ok(!Object.hasOwn(fold(source),'diagnostics'));
});
test('native comparisons preserve mixed promotion, nullable boxing, ordered callbacks and protected completion',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'complemented-relation-native-'));
 const run=(cmd,args)=>{const out=path.join(dir,'out'),err=path.join(dir,'err'),fds=[out,err].map(f=>fs.openSync(f,'w'));try{const r=spawnSync(cmd,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(err,'utf8'));return fs.readFileSync(out,'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const forms=[['int',''],['long',''],['Integer','intValue'],['Long','longValue'],['byte',''],['short',''],['char',''],['Byte','byteValue'],['Short','shortValue'],['Character','charValue']];
 const pairs=[...Array.from({length:16},(_,i)=>[Math.floor(i/4),i%4]),[4,0],[5,0],[6,0],[7,1],[8,1],[9,1],[1,4],[1,5],[1,6],[2,7],[3,8],[9,2]];
 const contexts=[s=>s,s=>`try{${s}}finally{event(7);if(mode==1)return snap(false);if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`,s=>`try{synchronized(lock){${s}}}finally{event(7);if(mode==1)return snap(false);if(mode==2)throw OVERRIDE;}`,s=>`try{${s}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(7);}`,s=>`{Object alias=lock;${s}if(alias!=lock)throw new AssertionError();}`];
 try{let methods='',models=0;for(const[a,b]of pairs)for(const op of ['<','<=','>','>='])for(const protect of contexts){
  const expression=`~left${a}() ${op} ~right${b}()`,source='boolean result=false;'+protect('result='+expression+';event(9);')+'return snap(result);',next=fold(source);assert.equal(next.comparisonsSimplified,1);
  const av=`left${a}()`+(forms[a][1]?'.'+forms[a][1]+'()':''),bv=`right${b}()`+(forms[b][1]?'.'+forms[b][1]+'()':'');const predicate={'<':'comparison>0','<=':'comparison>=0','>':'comparison<0','>=':'comparison<=0'}[op];
  const oracle='boolean result=false;'+protect(`long first=${av};long second=${bv};int comparison=Long.compare(first,second);result=${predicate};event(9);`)+'return snap(result);';
  for(const[name,body]of[['old',source],['next',next.source],['oracle',oracle]])methods+=`static String ${name}${models}(int mode){${body}}\n`;models++;
 }
 const java=`public class ComplementedRelationNative{static long left,right;static int inject,count;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static void event(int n){trace.append((char)('a'+n));count=count*31+n;if(inject==n)throw FAILURE;}${forms.map(([type,unbox],i)=>['left','right'].map((side,stage)=>{const primitive=unbox?({Integer:'int',Long:'long',Byte:'byte',Short:'short',Character:'char'})[type]:type,value='('+primitive+')'+side;return 'static '+type+' '+side+i+'(){event('+stage+');return '+(unbox?'inject=='+(stage+3)+'?null:'+type+'.valueOf('+value+')':value)+';}';}).join('')).join('')}static String snap(boolean result){return result+":"+count+":"+trace;}
${methods}
static String take(int kind,int variant,long a,long b,int failure,int mode,boolean nullLock){left=a;right=b;inject=failure;count=0;trace=new StringBuilder();lock=nullLock?null:new Object();String result;try{switch(kind){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(mode):variant==1?next${i}(mode):oracle${i}(mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError();return result+":"+count+":"+trace;}
public static void main(String[]args){long[]values={Long.MIN_VALUE,Long.MAX_VALUE,Integer.MIN_VALUE,(long)Integer.MIN_VALUE-1,Integer.MAX_VALUE,(long)Integer.MAX_VALUE+1,-1,0,1};int cases=0;for(int kind=0;kind<${models};kind++)for(long a:values)for(long b:values)for(int failure=0;failure<8;failure++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true}){String expected=take(kind,2,a,b,failure,mode,nullLock);for(int variant=0;variant<2;variant++)if(!take(kind,variant,a,b,failure,mode,nullLock).equals(expected))throw new AssertionError(kind+":"+variant+":"+a+":"+b+":"+failure);cases++;}System.out.println(cases+" cases, ${models} models");}}`;
 fs.writeFileSync(path.join(dir,'ComplementedRelationNative.java'),java);run('javac',['-d',dir,path.join(dir,'ComplementedRelationNative.java')]);assert.equal(run('java',['-Xmx128m','-cp',dir,'ComplementedRelationNative']),'2612736 cases, 672 models');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
