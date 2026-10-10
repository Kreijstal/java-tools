'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {simplifyNegatedEqualityValues:fold}=require('../src/decompiler/javaAstEmitter');
test('value equalities retain both operand occurrences and parentheses',()=>{
 for(const [source,expected]of [
  ['flag=!(left()==right());','flag=(left()!=right());'],
  ['return !(((left()!=right())));','return (((left()==right())));'],
  ['Object x=!(left()==right());','Object x=(left()!=right());'],
  ['use(!(left()==right()));','use((left()!=right()));'],
  ['boolean x=!(a==b==c);','boolean x=(a==b!=c);'],
  ['use(!((a==b)==c));','use(((a==b)!=c));'],
 ]){const result=fold(source,{retainDiagnostics:true});assert.equal(result.equalitiesSimplified,1,source);assert.equal(result.source,expected);let replay=source;for(const e of result.diagnostics.edits)replay=replay.slice(0,e.start)+e.text+replay.slice(e.end);assert.equal(replay,result.source);}
 const source='Object x=!(!(left()==right()));';let r=fold(source);assert.equal(r.equalitiesSimplified,1);r=fold(r.source);assert.equal(r.equalitiesSimplified,1);assert.equal(r.source,'Object x=((left()==right()));');
});
test('ordering, logical predicates and unknown double negations remain unchanged',()=>{
 for(const s of ['flag=!(a<b);','flag=!(a<=b);','flag=!(a>b);','flag=!(a>=b);','Object x=!!boxed;','return !(a==b&&c);','return !(a==b?first:second);','String x="!(a==b)";','char c=\'!\';','boolean[] flags=new boolean[2];'])assert.equal(fold(s).source,s,s);
 assert.equal(fold('flag=!(a==b);',{retainDiagnostics:1}).equalitiesSimplified,0);
});
test('nested operand work and equality inside a logical atom compose safely',()=>{
 const source='result=!(first[index()]==right(read(),!(x==y)));';let r=fold(source);assert.equal(r.equalitiesSimplified,1);assert.equal(r.source,'result=(first[index()]!=right(read(),!(x==y)));');r=fold(r.source);assert.equal(r.equalitiesSimplified,1);assert.equal(r.source,'result=(first[index()]!=right(read(),(x!=y)));');
 for(const atom of ['index()','right(','read()'])assert.equal(r.source.split(atom).length-1,1);
});
test('native comparisons preserve NaNs signed zero identities unboxing dispatch and protection',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'negated-equality-native-'));
 const run=(command,args)=>{const outputs=['out','err'].map(n=>path.join(directory,n)),fds=outputs.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(outputs[1],'utf8'));return fs.readFileSync(outputs[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}};
 const expressions=['!(leftDouble()==rightDouble())','!(leftInt()==rightInt())','!(leftRef()==rightRef())','!(leftBoxInt()==rightInt())','!(leftBoxBoolean()==rightBoolean())'];
 const oracleBodies=['double a=leftDouble(),b=rightDouble();boolean answer=Double.isNaN(a)||Double.isNaN(b);if(!answer){long x=Double.doubleToRawLongBits(a),y=Double.doubleToRawLongBits(b);answer=(x&Long.MAX_VALUE)==0&&(y&Long.MAX_VALUE)==0?false:x!=y;}',
  'int a=leftInt(),b=rightInt();boolean answer=Integer.compare(a,b)!=0;',
  'Object a=leftRef(),b=rightRef();boolean answer=identityTag(a)!=identityTag(b);',
  'int a=leftBoxInt();int b=rightInt();boolean answer=Integer.compare(a,b)!=0;',
  'boolean a=leftBoxBoolean();boolean b=rightBoolean();boolean answer=a^b;'];
 const wrappers=[s=>s,s=>`try{${s}}finally{event(4);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,s=>`synchronized(lock){${s}}`];
 try{let methods='',models=0;
  for(let kind=0;kind<expressions.length;kind++)for(const wrap of wrappers){const body=`Object result=choose(${expressions[kind]});selected=result==Boolean.TRUE;canonical=result==Boolean.TRUE||result==Boolean.FALSE;event(5);`,before=wrap(body)+'return snapshot();',next=fold(before);assert.equal(next.equalitiesSimplified,1);const oracle=wrap(oracleBodies[kind]+'Object result=choose(answer);selected=result==Boolean.TRUE;canonical=result==Boolean.TRUE||result==Boolean.FALSE;event(5);')+'return snapshot();';for(const[name,source]of [['old',before],['next',next.source],['oracle',oracle]])methods+=`static String ${name}${models}(int mode){${source}}\n`;models++;}
  const java=`public class EqualityValueOracle{
   static int li,ri,count,failAt;static boolean selected,canonical;static Object lock;static StringBuilder trace;
   static final Object FIRST=new Object(),SECOND=new Object();static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
   static final double[] D={-0.0,0.0,Double.NaN,Double.longBitsToDouble(0x7ff0000000000001L),Double.NEGATIVE_INFINITY,Double.POSITIVE_INFINITY,-1.0,1.0};static final int[] I={Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE,17,-17,42};static final Object[] R={null,FIRST,SECOND,FIRST,SECOND,null,FIRST,SECOND};static final Boolean[] B={null,false,true,false,true,null,true,false};
   static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}
   static double leftDouble(){event(1);return D[li];}static double rightDouble(){event(2);return D[ri];}static int leftInt(){event(1);return I[li];}static int rightInt(){event(2);return I[ri];}
   static Object leftRef(){event(1);return R[li];}static Object rightRef(){event(2);return R[ri];}static int identityTag(Object o){return o==null?0:o==FIRST?1:2;}
   static Integer leftBoxInt(){event(1);return li==0||li==5?null:Integer.valueOf(I[li]);}static Boolean leftBoxBoolean(){event(1);return B[li];}static boolean rightBoolean(){event(2);return ri%2==0;}
   static Object choose(boolean b){event(3);return b?Boolean.TRUE:Boolean.FALSE;}static Object choose(Boolean b){event(6);return b;}
   static String snapshot(){return count+":"+selected+":"+canonical+":"+trace;}
   ${methods}
   static String take(int model,int variant,int mode){count=0;selected=false;canonical=false;lock=new Object();trace=new StringBuilder();String result;try{switch(model){${Array.from({length:models},(_,i)=>`case ${i}:result=variant==0?old${i}(mode):variant==1?next${i}(mode):oracle${i}(mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
   public static void main(String[]args){int cases=0;for(int model=0;model<${models};model++)for(li=0;li<8;li++)for(ri=0;ri<8;ri++)for(int mode=0;mode<3;mode++)for(failAt=-1;failAt<8;failAt++){String expected=take(model,2,mode);for(int variant=0;variant<2;variant++){String actual=take(model,variant,mode);if(!actual.equals(expected))throw new AssertionError(model+":"+li+":"+ri+":"+mode+":"+failAt+":"+expected+":"+actual);}cases++;}System.out.println(cases);}}
  `;const file=path.join(directory,'EqualityValueOracle.java');fs.writeFileSync(file,java);run('javac',['--release','8','-d',directory,file]);assert.equal(run('java',['-Xmx128m','-cp',directory,'EqualityValueOracle']),'25920');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
