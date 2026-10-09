'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {simplifyPredicateNegations: simplify} = require('../src/decompiler/javaAstEmitter');
const {tokenizeJava} = require('../src/java-frontend/lexer');

function fixed(source) {
  let count = 0;
  for (;;) {
    const r = simplify(source, {retainDiagnostics: true});
    if (!r.predicatesSimplified) return {source, count};
    source = r.source; count += r.predicatesSimplified;
    assert.ok(count < 100);
  }
}

test('negated equality and Boolean trees preserve operands and reach a fixed point', () => {
  const source = 'if (!((a != b) && (c != d))) hit(); if (!(!(!ready))) finish();';
  const r = fixed(source);
  assert.equal(r.source, 'if (((a == b) || (c == d))) hit(); if (((!ready))) finish();');
  assert.equal(r.count, 2);
  assert.equal(fixed(r.source).count, 0);
  const nested = simplify('if(!((left()==right()) || !((first!=second)&&(third!=fourth))))hit();');
  assert.match(nested.source, /left\(\)!=right\(\)/);
  assert.match(nested.source, /first!=second/);
  assert.match(nested.source, /third!=fourth/);
});

test('if, while, braced do-while and for conditions support the same Boolean proof', () => {
  for (const source of [
    'if(!((a!=b)&&(c!=d)))hit();', 'while(!((a!=b)&&(c!=d))){hit();break;}',
    'do{hit();}while(!((a!=b)&&(c!=d)));', 'for(int i=0;!((a!=b)&&(c!=d));i++){hit();break;}',
  ]) assert.equal(simplify(source).predicatesSimplified, 1, source);
  assert.equal(simplify('if(!true)hit();').source, 'if(false)hit();');
  assert.equal(simplify('if(!(a&&b))hit();').source, 'if((!(a)||!(b)))hit();');
});

test('floating relations and opaque arguments stay exact; boxed identity operands stay opaque', () => {
  for (const source of [
    'if(!(value < other))hit();', 'if(!(value >= other))hit();',
    'if(!(call(first != second, boxed == other)))hit();',
    'if((!!boxed)==other)hit();', 'Boolean result=!!boxed;return result;',
    'return !!boxed;', 'consume(!!boxed);',
  ]) assert.equal(simplify(source).source, source);
  const r = simplify('if(!((call(first!=second))&&(floating<other)))hit();');
  assert.match(r.source, /!\(call\(first!=second\)\)/);
  assert.match(r.source, /!\(floating<other\)/);
  assert.doesNotMatch(r.source, /floating>=other|first==second/);
  assert.equal(simplify('if(!((!!boxed)==other))hit();').source, 'if(((!!boxed)!=other))hit();');
});

test('comments, Unicode translation, nested executables and budgets refuse', () => {
  const good = 'if(!((a!=b)&&(c!=d)))hit();';
  for (const source of [good+' // comment\n', good+'\\u000a', good+'Runnable r=()->hit();',
    good+'class Nested{void f(){hit();}}', good+'if (',
    'if('+ '!('.repeat(67)+'ready'+')'.repeat(67)+')hit();',
    good+' '.repeat(400001),
  ]) assert.equal(simplify(source).source, source);
  assert.equal(simplify(good,{retainDiagnostics:'true'}).source,good);
  assert.equal(simplify(good,{complementIntegralRelations:1}).source,good);
  assert.equal(simplify('if(!((text.equals("//"))&&(a!=b)))hit();').predicatesSimplified,1);
});

test('diagnostic edits account for all changed tokens and retain identifier order', () => {
  const source = 'try{if(!((step(a++)!=read(b))&&(!boxed||!(f<x()))))hit();}finally{finish();}';
  const r = simplify(source, {retainDiagnostics: true});
  assert.equal(r.predicatesSimplified,1);
  let expected=source;
  for(const edit of r.diagnostics.tokenEdits.slice().reverse())
    expected=expected.slice(0,edit.start)+edit.text+expected.slice(edit.end);
  assert.equal(r.source,expected);
  const identifiers=s=>tokenizeJava(s).tokens.filter(t=>t.kind==='identifier').map(t=>t.text);
  assert.deepEqual(identifiers(r.source),identifiers(source));
  assert.deepEqual(r.diagnostics.counts,{doubleNegations:2,equalityComplements:1,deMorganOperators:2,booleanLiterals:0,relationalComplements:0});
});

test('native conditions match an independent ordered oracle across boxed identity, NaN and abrupt effects', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'predicate-negations-native-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const predicate='!((state++ != b) && (probe(0,mode,boxed) || !probe(1,mode,other)) && !(left != right) && (fa < fb) && !(boxed == other))';
  const suffix='return result+":"+state+":"+trace;';
  const bodies=[
    `boolean result=false;if(${predicate}){trace.append('T');result=true;}${suffix}`,
    `boolean result=false;while(${predicate}){trace.append('T');result=true;break;}${suffix}`,
    `boolean result=true;do{trace.append('D');}while((${predicate})&&again());${suffix}`,
    `boolean result=false;for(;${predicate};){trace.append('T');result=true;break;}${suffix}`,
    `boolean result=false;Outer:{try{if(${predicate}){trace.append('T');result=true;break Outer;}}finally{trace.append('F');if(mode==4)throw FAILURE;if(mode==5)result=!result;}}${suffix}`,
    `boolean result=false;synchronized(lock){trace.append('L');if(${predicate}){trace.append('T');result=true;}}${suffix}`,
  ];
  try {
    let methods='';
    const parameters='int b,int mode,Boolean boxed,Boolean other,Object left,Object right,float fa,float fb,Object lock';
    for(let i=0;i<bodies.length;i++){
      const next=fixed(bodies[i]);assert.ok(next.count>0,'variant '+i);
      methods+=`static String old${i}(${parameters}){${bodies[i]}}\nstatic String next${i}(${parameters}){${next.source}}\n`;
    }
    const fixture=`public class PredicateNegations {
      static int state;static StringBuilder trace;static final RuntimeException FAILURE=new RuntimeException();
      static Boolean probe(int index,int mode,Boolean value){trace.append(index);state+=7;if(mode==index+1)throw FAILURE;return value;}
      static boolean again(){trace.append('G');return false;}
      ${methods}
      // Independent statement-by-statement oracle; no AST rewrite or renderer.
      static boolean expected(int b,int mode,Boolean boxed,Boolean other,Object left,Object right,float fa,float fb){
        int prior=state++;if(prior==b)return true;
        boolean first=probe(0,mode,boxed);if(!first){boolean second=probe(1,mode,other);if(second)return true;}
        if(left!=right)return true;if(!(fa<fb))return true;return boxed==other;
      }
      static String oracle(int v,${parameters}){boolean result=false;
        if(v==5){if(lock==null)throw new NullPointerException();trace.append('L');}
        if(v==2){trace.append('D');if(expected(b,mode,boxed,other,left,right,fa,fb))again();result=true;}
        else if(v==4){try{if(expected(b,mode,boxed,other,left,right,fa,fb)){trace.append('T');result=true;}}finally{trace.append('F');if(mode==4)throw FAILURE;if(mode==5)result=!result;}}
        else if(expected(b,mode,boxed,other,left,right,fa,fb)){trace.append('T');result=true;}
        return result+":"+state+":"+trace;
      }
      static String invoke(int kind,int v,int initial,${parameters}){state=initial;trace=new StringBuilder();try{
        if(kind==2)return oracle(v,b,mode,boxed,other,left,right,fa,fb,lock);
        switch(v){${bodies.map((_,i)=>`case ${i}:return kind==0?old${i}(b,mode,boxed,other,left,right,fa,fb,lock):next${i}(b,mode,boxed,other,left,right,fa,fb,lock);`).join('')}}throw new AssertionError();
      }catch(Throwable failure){if(failure==FAILURE)return "failure:"+state+":"+trace;if(failure instanceof NullPointerException)return "null:"+state+":"+trace;throw new AssertionError(failure);}}
      public static void main(String[]args){Boolean[] flags={null,Boolean.FALSE,Boolean.TRUE,new Boolean(false),new Boolean(true)};
        int[][] ints={{0,0},{0,1},{1,0},{-1,0},{Integer.MAX_VALUE,Integer.MAX_VALUE},{Integer.MIN_VALUE,Integer.MIN_VALUE},{Integer.MAX_VALUE,Integer.MIN_VALUE},{Integer.MIN_VALUE,Integer.MAX_VALUE},{2,-2}};
        float[] floats={Float.NaN,-0.0f,0.0f,Float.POSITIVE_INFINITY,Float.NEGATIVE_INFINITY};Object one=new Object(),two=new Object();Object[][] refs={{one,one},{one,two},{null,null}};int count=0;
        for(int v=0;v<6;v++)for(int[]pair:ints)for(float fa:floats)for(float fb:floats)for(Boolean boxed:flags)for(Boolean other:flags)for(Object[]ref:refs)for(int mode=0;mode<7;mode++){
          Object lock=mode==6?null:one;String expected=invoke(2,v,pair[0],pair[1],mode,boxed,other,ref[0],ref[1],fa,fb,lock);
          for(int kind=0;kind<2;kind++){String actual=invoke(kind,v,pair[0],pair[1],mode,boxed,other,ref[0],ref[1],fa,fb,lock);if(!actual.equals(expected))throw new AssertionError(v+":"+mode+":"+actual+" != "+expected);if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");}count++;
        }System.out.println(count+" independent ordered predicate cases");}
    }`;
    const file=path.join(temporary,'PredicateNegations.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);
    assert.equal(run('java',['-Xmx128m','-cp',temporary,'PredicateNegations']).trim(),'708750 independent ordered predicate cases');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('scoped integral types complement relations without altering operands or floating comparisons', () => {
  const cases = [
    ['int i=0; if(!(i<3))hit();', 'int i=0; if((i>=3))hit();'],
    ['long i=0; if(!(i<=0xFEDCL))hit();', 'long i=0; if((i>0xFEDCL))hit();'],
    ["if(!('x'>0xFE))hit();", "if(('x'<=0xFE))hit();"],
    ['int[] a=null; if(!(a[0]>=a.length))hit();', 'int[] a=null; if((a[0]<a.length))hit();'],
    ['Sprite[] a=null; if(!(a.length<2))hit();', 'Sprite[] a=null; if((a.length>=2))hit();'],
    ['int a[]=null; if(!(a[0]<2))hit();', 'int a[]=null; if((a[0]>=2))hit();'],
    ['if(!((int)read()<(long)other()))hit();', 'if(((int)read()>=(long)other()))hit();'],
    ['int a=0,b=0; if(!((a+b)*a<(b-a)>>>b))hit();', 'int a=0,b=0; if(((a+b)*a>=(b-a)>>>b))hit();'],
    ['int a=0; while(!(a++<3)){break;}', 'int a=0; while((a++>=3)){break;}'],
    ['int a=0; do{hit();}while(!(a<3));', 'int a=0; do{hit();}while((a>=3));'],
    ['int a=0; for(;!(a<3);a++){break;}', 'int a=0; for(;(a>=3);a++){break;}'],
  ];
  for (const [source, expected] of cases) {
    const r=simplify(source,{retainDiagnostics:true});
    assert.equal(r.source,expected); assert.equal(r.diagnostics.counts.relationalComplements,1);
    assert.equal(simplify(r.source).source,r.source);
  }
  for (const source of [
    'try{int a=0; if(!(a<2))hit();}finally{finish();}',
    'try{int a=0; if(!(a<2))hit();}catch(Exception e){hit();}',
    'try{hit();}catch(Exception e){int a=0;if(!(a<2))hit();}',
    'synchronized(lock){int a=0;if(!(a<2))hit();}',
  ]) assert.equal(simplify(source).source,source.replace('!(a<2)','(a>=2)'));
  const parameters=[{name:'a',type:'int'},{name:'b',type:'long'},{name:'values',type:'int[]'}];
  assert.equal(simplify('if(!(a<b))hit();',{parameters}).source,'if((a>=b))hit();');
  assert.equal(simplify('if(!(values[a]<b))hit();',{parameters}).source,'if((values[a]>=b))hit();');
  const integral='int a=0; if(!(a<2))hit();';
  assert.equal(simplify(integral,{complementIntegralRelations:false}).source,integral);
  const r=simplify('int a=0; float f=0; if(!((a<2)&&(f<2)))hit();');
  assert.equal(r.source,'int a=0; float f=0; if(((a>=2)||(!(f<2))))hit();');
});

test('unproven types, shadowing and declaration scopes cannot justify relational complements', () => {
  for(const source of [
    'float a=0; int b=0; if(!(a<b))hit();', 'double a=0; if(!(a<0x1p4))hit();',
    'int a=0; if(!(a<1F))hit();', 'int a=0; if(!(a<1e4))hit();',
    'Integer a=0; if(!(a<2))hit();', 'int a=0; if(!(a<read()))hit();',
    'int a=0; if(!(a<object.length))hit();',
    '{int a=0;} if(!(a<2))hit();', 'if(!(a<2))hit(); int a=0;',
    '{int a=0;if(!(a<2))hit();}{float a=0;if(!(a<2))hit();}',
    'for(int a=0;!(a<2);a++)hit();', 'for(Integer a:values)if(!(a<2))hit();',
    'if(!(0x1.fp2<2))hit();',
  ]) assert.equal(simplify(source).source,source,source);
  const source='int a=0; if(!(a<2))hit();';
  for(const parameters of [null,{},[{name:'a',type:'float'}],[{name:'a',type:'int'},{name:'a',type:'int'}],
    [{name:'a.b',type:'int'}],[{name:'a',type:null}]])
    assert.equal(simplify(source,{parameters}).source,source);
});

test('native integral complements match ordered comparison oracles through overflow, NaN casts and exceptions', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'integral-predicate-native-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const variants=[
    {left:'a++',right:'b--',operator:'<',oracle:'long left=a;a++;long right=b;b--;'},
    {left:'(a+b)*a',right:'(b-a)/denom',operator:'<=',oracle:'long left=(a+b)*a;long right=(b-a)/denom;'},
    {left:'((long)a<<shift)',right:'((long)b>>>shift)',operator:'>',oracle:'long left=(long)a<<shift;long right=(long)b>>>shift;'},
    {left:'(int)floating',right:'(long)a',operator:'>=',oracle:'long left=(int)floating;long right=(long)a;'},
    {left:'array[index]',right:'array.length',operator:'<',oracle:'long left=array[index];long right=array.length;'},
    {left:'((char)a^(byte)b)',right:'(short)denom',operator:'<=',oracle:'long left=(char)a^(byte)b;long right=(short)denom;'},
    {left:'(int)mark(a++,mode,0)',right:'(int)mark(b--,mode,1)',operator:'>',oracle:'int first=a;a++;long left=(int)mark(first,mode,0);int second=b;b--;long right=(int)mark(second,mode,1);'},
  ];
  const parameterText='int a,int b,int denom,int shift,float floating,int[] array,int index,int mode,Object lock';
  const parameters=[['a','int'],['b','int'],['denom','int'],['shift','int'],['floating','float'],['array','int[]'],['index','int'],['mode','int'],['lock','Object']].map(([name,type])=>({name,type}));
  const tail='return result+":"+a+":"+b+":"+effects+":"+trace;';
  const wrap=(test,prelude='')=>`boolean result=false;Outer:{try{synchronized(lock){trace.append('L');${prelude}if(${test}){trace.append('T');result=true;break Outer;}}}finally{trace.append('F');if(mode==3)throw FAILURE;}}${tail}`;
  try {
    let methods='';
    for(let i=0;i<variants.length;i++){
      const v=variants[i], body=wrap(`!(${v.left}${v.operator}${v.right})`);
      const next=simplify(body,{parameters,retainDiagnostics:true});
      assert.equal(next.diagnostics.counts.relationalComplements,1,'variant '+i);
      const comparison={'<':'>=0','<=':'>0','>':'<=0','>=':'<0'}[v.operator];
      const oracle=wrap(`Long.compare(left,right)${comparison}`,v.oracle);
      methods+=`static String old${i}(${parameterText}){${body}}\nstatic String next${i}(${parameterText}){${next.source}}\nstatic String oracle${i}(${parameterText}){${oracle}}\n`;
    }
    const fixture=`public class IntegralPredicates {
      static StringBuilder trace;static int effects;static final RuntimeException FAILURE=new RuntimeException();
      static long mark(int value,int mode,int stage){trace.append(stage).append(':').append(value).append(';');effects+=7;if(mode==stage+1)throw FAILURE;return value;}
      ${methods}
      static String invoke(int kind,int variant,${parameterText}){trace=new StringBuilder();effects=0;try{switch(variant){
        ${variants.map((_,i)=>`case ${i}:return kind==0?old${i}(a,b,denom,shift,floating,array,index,mode,lock):kind==1?next${i}(a,b,denom,shift,floating,array,index,mode,lock):oracle${i}(a,b,denom,shift,floating,array,index,mode,lock);`).join('')}
      }throw new AssertionError();}catch(Throwable e){if(e==FAILURE)return "failure:"+effects+":"+trace;if(e instanceof NullPointerException)return "null:"+effects+":"+trace;if(e instanceof ArithmeticException)return "division:"+effects+":"+trace;if(e instanceof ArrayIndexOutOfBoundsException)return "bounds:"+effects+":"+trace;throw new AssertionError(e);}}
      public static void main(String[]args){int[][] pairs={{0,0},{0,1},{1,0},{-1,0},{Integer.MAX_VALUE,Integer.MAX_VALUE},{Integer.MIN_VALUE,Integer.MIN_VALUE},{Integer.MAX_VALUE,Integer.MIN_VALUE},{Integer.MIN_VALUE,Integer.MAX_VALUE},{2,-2}};
        float[] floats={Float.NaN,-0.0f,0.0f,Float.POSITIVE_INFINITY,Float.NEGATIVE_INFINITY};int[] shifts={-65,-1,0,1,31,32,63,64};int[][] arrays={null,{}, {Integer.MIN_VALUE,0,Integer.MAX_VALUE}};Object lock=new Object();int count=0;
        for(int v=0;v<7;v++)for(int[]p:pairs)for(int d:new int[]{-1,0,1})for(int shift:shifts)for(float f:floats)for(int[]array:arrays)for(int index:new int[]{-1,0,2,3})for(int mode=0;mode<5;mode++){
          Object monitor=mode==4?null:lock;String expected=invoke(2,v,p[0],p[1],d,shift,f,array,index,mode,monitor);
          for(int kind=0;kind<2;kind++){String actual=invoke(kind,v,p[0],p[1],d,shift,f,array,index,mode,monitor);if(!actual.equals(expected))throw new AssertionError(v+":"+mode+":"+actual+" != "+expected);if(Thread.holdsLock(lock))throw new AssertionError("monitor leaked");}count++;
        }System.out.println(count+" independent integral predicate cases");}
    }`;
    const file=path.join(temporary,'IntegralPredicates.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);
    assert.equal(run('java',['-Xmx128m','-cp',temporary,'IntegralPredicates']).trim(),'453600 independent integral predicate cases');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

const ownedFields = {owner:'OwnedPredicates', classQualifierUnshadowed:true, fields:[
  ['tick','int',false],['limit','long',false],['shared','long',true],
  ['values','int[]',false],['small','byte',false],['letter','char',false],
  ['floating','float',false],['boxed','Integer',false],['ready','Boolean',false],
].map(([name,type,staticField])=>({name,type,static:staticField}))};

test('owned primitive field evidence complements relations without altering receiver or read order', () => {
  const source='if(!(this.tick++ < OwnedPredicates.shared) || !(this.letter >= this.small))hit();';
  const next=simplify(source,{ownedFields,retainDiagnostics:true});
  assert.equal(next.source,'if((this.tick++ >= OwnedPredicates.shared) || (this.letter < this.small))hit();');
  assert.equal(next.diagnostics.counts.relationalComplements,2);
  assert.deepEqual(next.diagnostics.relationalComparisons.map(c=>[c.leftType,c.rightType]),[['int','long'],['char','byte']]);
  assert.equal(simplify(next.source,{ownedFields}).predicatesSimplified,0);
  assert.equal(simplify(source).source,source,'default contract retains unknown field comparisons');
});

test('owned arrays prove element and length types while keeping bounds/null/increment effects', () => {
  const source='int index=0;if(!(this.values[index++] < this.values.length))hit();';
  assert.equal(simplify(source,{ownedFields}).source,'int index=0;if((this.values[index++] >= this.values.length))hit();');
  assert.equal(simplify('if(!(this.values[read()] < (int)callback()))hit();',{ownedFields}).predicatesSimplified,1);
  assert.equal(simplify('if(!(this.tick < callback()))hit();',{ownedFields}).predicatesSimplified,0);
});

test('field evidence refuses arbitrary, inherited, shadowed and unqualified receivers', () => {
  const qualified='if(!(OwnedPredicates.shared < 4))hit();';
  assert.equal(simplify(qualified,{ownedFields:{owner:ownedFields.owner,fields:ownedFields.fields}}).source,qualified,
    'class-qualified evidence requires a complete field/member-type shadowing proof');
  assert.equal(simplify(qualified,{ownedFields:{...ownedFields,classQualifierUnshadowed:false}}).source,qualified,
    'known inherited field/member-type shadowing declines the class qualifier');
  assert.equal(simplify(qualified,{ownedFields:{...ownedFields,fields:[...ownedFields.fields,
    {name:'OwnedPredicates',type:'Other',static:false}]}}).source,qualified,'own field can shadow a type qualifier');
  for(const source of [
    'if(!(other.tick < 4))hit();','if(!(super.tick < 4))hit();','if(!(tick < 4))hit();',
    'if(!(this.missing < 4))hit();','if(!(OwnedPredicates.tick < 4))hit();',
    'Object OwnedPredicates=null;if(!(OwnedPredicates.shared < 4))hit();',
    'for(int OwnedPredicates=0;OwnedPredicates<1;OwnedPredicates++){if(!(OwnedPredicates.shared < 4))hit();}',
    'try{hit();}catch(Exception OwnedPredicates){if(!(OwnedPredicates.shared < 4))hit();}',
  ]) assert.equal(simplify(source,{ownedFields}).source,source);
  const source='if(!(OwnedPredicates.shared < 4))hit();';
  assert.equal(simplify(source,{ownedFields,parameters:[{name:'OwnedPredicates',type:'Object'}]}).source,source);
});

test('floating and boxed owned fields retain NaN and unboxing outcomes', () => {
  for(const source of ['if(!(this.floating < 4))hit();','if(!(this.boxed >= 4))hit();',
    'if(!(this.tick < this.floating))hit();','if(!(this.ready))hit();'])
    assert.equal(simplify(source,{ownedFields}).source,source);
  assert.equal(simplify('if(!(this.tick < (int)this.floating))hit();',{ownedFields}).source,
    'if((this.tick >= (int)this.floating))hit();');
});

test('invalid or ambiguous owned field contracts fail closed', () => {
  const source='if(!(this.tick < 4))hit();';
  for(const bad of [[],{}, {owner:'x/y',fields:[]},{owner:'X',fields:{}},
    {owner:'X',fields:[],classQualifierUnshadowed:1},
    {owner:'X',fields:[{name:'tick',type:'int',static:0}]},
    {owner:'X',fields:[{name:'tick',type:'int[]bad',static:false}]},
    {owner:'X',fields:[{name:'tick',type:'int',static:false},{name:'tick',type:'float',static:false}]},
  ]) assert.equal(simplify(source,{ownedFields:bad}).source,source);
  for(const suffix of [' // comment\n','\\u000a','Runnable r=()->hit();','class Inner{void f(){hit();}}'])
    assert.equal(simplify(source+suffix,{ownedFields}).source,source+suffix);
});

test('native owned-field complements preserve reads, writes, volatile callbacks and protected failures', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'owned-field-predicates-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const variants=[
    {test:'!(this.tick < OwnedPredicates.shared)',oracle:'long left=this.tick;long right=shared;boolean result=Long.compare(left,right)>=0;',changes:1},
    {test:'!(this.tick++ <= (int)mark(mode))',oracle:'long left=this.tick;this.tick++;long right=(int)mark(mode);boolean result=Long.compare(left,right)>0;',changes:1},
    {test:'!(this.values[index++] > this.values.length)',oracle:'long left=this.values[index++];long right=this.values.length;boolean result=Long.compare(left,right)<=0;',changes:1},
    {test:'!(this.letter >= this.small)',oracle:'long left=this.letter;long right=this.small;boolean result=Long.compare(left,right)<0;',changes:1},
    {test:'!((this.tick < (int)mark(mode)) && !(this.tick >= this.limit))',oracle:'long left=this.tick;long right=(int)mark(mode);boolean result=Long.compare(left,right)>=0;if(!result){left=this.tick;right=this.limit;result=Long.compare(left,right)>=0;}',changes:1},
    {test:'!(this.floating < this.tick)',oracle:'boolean result=Float.isNaN(this.floating)||Float.compare(this.floating, (float)this.tick)>0||this.floating==(float)this.tick;',changes:0},
    {test:'!(this.boxed < this.tick)',oracle:'long left=this.boxed.intValue();long right=this.tick;boolean result=Long.compare(left,right)>=0;',changes:0},
  ];
  const parameters=[{name:'mode',type:'int'},{name:'index',type:'int'},{name:'lock',type:'Object'}];
  const tail='trace.append(result?"T":"N");return result+":"+tick+":"+shared+":"+index+":"+trace;';
  const wrap=code=>`try{synchronized(lock){trace.append("L");${code}${tail}}}finally{trace.append("F");if(mode==3)throw FAILURE;}`;
  try{
    let methods='';
    const memberShadowBody='if(!(QualifierMemberShadow.shared >= 0))return true;return false;';
    const memberShadowNext=simplify(memberShadowBody,{ownedFields:{owner:'QualifierMemberShadow',classQualifierUnshadowed:false,
      fields:[{name:'shared',type:'int',static:true}]}}).source;
    assert.equal(memberShadowNext,memberShadowBody);
    const fieldShadowBody='if(!(QualifierFieldShadow.shared >= 0))return true;return false;';
    const fieldShadowNext=simplify(fieldShadowBody,{ownedFields:{owner:'QualifierFieldShadow',classQualifierUnshadowed:true,
      fields:[{name:'shared',type:'int',static:true},{name:'QualifierFieldShadow',type:'QualifierFloatHolder',static:false}]}}).source;
    assert.equal(fieldShadowNext,fieldShadowBody);
    variants.forEach((v,i)=>{
      // Only control-condition operands are rewritten by this API.
      const original=wrap('boolean result=false;if('+v.test+')result=true;');
      const next=simplify(original,{ownedFields,parameters,retainDiagnostics:true});
      assert.equal(next.diagnostics?.counts.relationalComplements??0,v.changes,'variant '+i);
      methods+=`String old${i}(int mode,int index,Object lock){${original}}\nString next${i}(int mode,int index,Object lock){${next.source}}\nString oracle${i}(int mode,int index,Object lock){${wrap(v.oracle)}}\n`;
    });
    const fixture=`public class OwnedPredicates {
      volatile int tick;long limit;static volatile long shared;int[]values;byte small;char letter;float floating;Integer boxed;StringBuilder trace;
      static final RuntimeException FAILURE=new RuntimeException();
      long mark(int mode){trace.append("C").append(tick).append(';');tick=tick+7;shared=shared-1;if(mode==1)throw FAILURE;return tick;}
      ${methods}
      static String invoke(int kind,int v,int a,long b,int index,int mode,int[]array,float f,Object monitor){
        OwnedPredicates p=new OwnedPredicates();p.tick=a;p.limit=b;shared=b;p.values=array;p.small=(byte)a;p.letter=(char)b;p.floating=f;p.boxed=mode==2?null:Integer.valueOf((int)b);p.trace=new StringBuilder();
        try{switch(v){${variants.map((_,i)=>`case ${i}:return kind==0?p.old${i}(mode,index,monitor):kind==1?p.next${i}(mode,index,monitor):p.oracle${i}(mode,index,monitor);`).join('')}}throw new AssertionError();}
        catch(Throwable e){String type=e==FAILURE?"injected":e instanceof NullPointerException?"null":e instanceof ArrayIndexOutOfBoundsException?"bounds":null;if(type==null)throw new AssertionError(e);return type+":"+p.tick+":"+shared+":"+p.trace;}
      }
      public static void main(String[]args){Object lock=new Object();int count=2;
        if(!QualifierMemberShadow.old()||!QualifierMemberShadow.next()||!new QualifierFieldShadow().old()||!new QualifierFieldShadow().next())throw new AssertionError("NaN qualifier shadowing");
        for(int v=0;v<${variants.length};v++)for(int a:new int[]{0,1,-1,Integer.MIN_VALUE,Integer.MAX_VALUE})for(long b:new long[]{0,1,-1,Long.MIN_VALUE,Long.MAX_VALUE})
        for(int index:new int[]{-1,0,2,3})for(int mode=0;mode<5;mode++)for(int[]array:new int[][]{null,{}, {Integer.MIN_VALUE,0,Integer.MAX_VALUE}})
        for(float f:new float[]{Float.NaN,-0.0f,0.0f,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY}){
          Object monitor=mode==4?null:lock;String expected=invoke(2,v,a,b,index,mode,array,f,monitor);
          for(int kind=0;kind<2;kind++){String actual=invoke(kind,v,a,b,index,mode,array,f,monitor);if(!actual.equals(expected))throw new AssertionError(v+":"+actual+" != "+expected);if(Thread.holdsLock(lock))throw new AssertionError("monitor leak");}count++;
        }System.out.println(count+" independent owned-field cases");}
    }
    class QualifierParent {static class QualifierMemberShadow {static float shared=Float.NaN;}}
    class QualifierMemberShadow extends QualifierParent {static int shared=1;static boolean old(){${memberShadowBody}}static boolean next(){${memberShadowNext}}}
    class QualifierFloatHolder {float shared=Float.NaN;}
    class QualifierFieldShadow {static int shared=1;QualifierFloatHolder QualifierFieldShadow=new QualifierFloatHolder();boolean old(){${fieldShadowBody}}boolean next(){${fieldShadowNext}}}
    `;
    const file=path.join(temporary,'OwnedPredicates.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);
    assert.equal(run('java',['-XX:-OmitStackTraceInFastThrow','-Xmx128m','-cp',temporary,'OwnedPredicates']).trim(),'52502 independent owned-field cases');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
