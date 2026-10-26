'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const {simplifyBodyDecisions:body,simplifyCompilationUnitDecisions:unit}=require('../src/decompiler/javaAstEmitter');

test('normalizes Boolean controls and ordered branches while preserving source indentation',()=>{
 const source='\n        if (!(!test())) {\n          hit();\n        } else {\n          if (next()) {\n            miss();\n          }\n        }\n    ';
 const result=body(source);assert.match(result.source,/\n        if \(test\(\)\) \{\n          hit\(\);/);assert.match(result.source,/else if/);assert.ok(result.predicatesSimplified);assert.ok(result.elseIfBlocksRemoved);assert.equal(body(result.source).source,result.source);
});

test('compilation units reuse the default decision proofs without touching headers or fields',()=>{
 const source='/* kept { } */\npackage example;\nclass A {\n String value="if (!(a < b))";\n void f(){\n  if(!(!test())){work();}\n }\n class B{void g(){if(!(a < b)){work();}}}\n}';
 const result=unit(source);assert.equal(result.bodiesSimplified,1);assert.ok(result.source.startsWith('/* kept { } */\npackage example;'));assert.match(result.source,/String value="if \(!\(a < b\)\)";/);assert.match(result.source,/\n  if\(test\(\)\)\{work\(\);\}/);assert.ok(result.source.includes('if(!(a < b))'));assert.equal(unit(result.source).source,result.source);
});

test('default source decisions fold proven primitive choices without external type flags',()=>{
 const source='class Choices{void run(){int value=0;while(again()){if(test()){value=1;}else{value=2;}use(value);}}}';
 const result=unit(source);assert.equal(result.valueBranchesFolded,1);assert.equal(result.bodiesSimplified,1);
 assert.ok(!result.source.includes('if(test())'));assert.match(result.source,/value = \(test\(\)\) \? \(1\) : \(2\);/);
 assert.equal(unit(result.source).source,result.source);
});

test('default value recovery keeps complete ordered ladders rather than mixing a partial ternary',()=>{
 for(const source of [
  'int value=0;if(first()){value=1;}else if(second()){value=2;}else{value=3;}',
  'double value=0;if(first()){value=1.0;}else{{if(second()){value=2.0;}else{value=3.0;}}}',
  'double value=0;if(!(number<1.0)){if(!(number<2.0)){if(third()){value=1.0;}else{value=2.0;}}else{value=3.0;}}else{value=4.0;}',
  'int value=0;if(first()){{if(second()){value=1;}else{value=2;}}}else{value=3;}',
 ]){const result=body(source);assert.equal(result.valueBranchesFolded,0);assert.ok(!result.source.includes('?'));assert.equal(body(result.source).source,result.source);}
});

for(const source of[
 'int selected=read();Runnable r=()->{if(!(!test()))work();};',
 'class Local{void f(){if(!(!test()))work();}}',
 'Object r=new Runnable(){public void run(){if(!(!test()))work();}};',
 'if(!(!test())){/* keep */work();}',
 'if(!(!test())){work();}\\u000a',
 'if(!(!test())){',
])test('refuses ambiguous, captured or unsupported body offsets: '+source,()=>assert.equal(body(source).source,source));

test('keeps unknown and floating relational negations and boxed value contexts',()=>{
 for(const source of ['if(!(floating < 0.0)){work();}','Boolean boxed=null;Object value=!!boxed;','if(!(call()<other())){work();}'])assert.equal(body(source).source,source);
});

test('whole-source decisions compile and match native values, unboxing and effect order',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'source-decisions-native-'));
 const run=(cmd,args,cwd)=>{const r=spawnSync(cmd,args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.error?.stack||r.stdout);return r.stdout;};
 try{
  const original=path.join(temporary,'old'),next=path.join(temporary,'next');fs.mkdirSync(original);fs.mkdirSync(next);
  const source=`class SourceDecisionNative{
   static int calls;static Boolean predicate(int n){calls++;return n==2?null:n>0;}
   static String decide(int input,double floating){
    int selected=input;
    try{
     Frame:{
      if(selected==0){
       if(!(!predicate(input))){selected++;}
      }else{
       if(selected==1){
        if(predicate(input)){int temporary=selected;selected=temporary+7;}
       }else{
        if(selected==2){
         if(!(floating<0.0)){selected=17;}
        }else{
         selected=9;
         if(!(!predicate(input-1))){selected=12;}
        }
       }
      }
     }
     return selected+":"+calls;
    }catch(Throwable failure){return failure.getClass().getName()+":"+calls;}
   }
   public static void main(String[]args){for(int input=-1;input<4;input++)for(double f:new double[]{Double.NaN,Double.NEGATIVE_INFINITY,-0.0,0.0,Double.POSITIVE_INFINITY}){calls=0;System.out.println(decide(input,f));}}
  }`;
  const result=unit(source);assert.ok(result.dispatchesRecovered);assert.ok(result.predicatesSimplified);assert.ok(result.source.includes('!(floating<0.0)'));assert.equal(unit(result.source).source,result.source);
  for(const[dir,text]of[[original,source],[next,result.source]]){fs.writeFileSync(path.join(dir,'SourceDecisionNative.java'),text);run('javac',['--release','8','SourceDecisionNative.java'],dir);}
  const expected=run('java',['-Xverify:all','-cp',original,'SourceDecisionNative'],original);assert.equal(expected.trim().split('\n').length,25);assert.match(expected,/java\.lang\.NullPointerException/);assert.match(expected,/17:0/);assert.match(expected,/2:0/);assert.equal(run('java',['-Xverify:all','-cp',next,'SourceDecisionNative'],next),expected);
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
