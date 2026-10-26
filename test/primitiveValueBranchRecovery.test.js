'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {foldPrimitiveValueBranches} = require('../src/decompiler/javaAstEmitter');
const {decompileClassFile} = require('../src/decompiler/cfr');

const types = new Map([['value','int'], ['left','int'], ['right','int']]);
const recover = source => foldPrimitiveValueBranches(source, {localType: name => types.get(name)});
const decision = 'if (probe()) { value = left; } else { value = right; }';
for (const [name, wrap] of [
  ['plain block', value => `{ ${value} consume(value); }`],
  ['while', value => `while (again()) { ${value} consume(value); }`],
  ['for', value => `for (int index=0;index<3;index++) { ${value} consume(value); }`],
  ['do while', value => `do { ${value} consume(value); } while (again());`],
  ['handler', value => `try { work(); } catch (RuntimeException failure) { ${value} consume(value); }`],
  ['finally', value => `try { work(); } finally { ${value} consume(value); }`],
  ['monitor', value => `synchronized (lock) { ${value} consume(value); }`],
  ['label and switch', value => `Outer: while(again()) { switch(kind) { case 1: ${value} break; default: continue Outer; } }`],
]) test(`folds a primitive value decision inside ${name} without changing its surroundings`, () => {
  const source = wrap(decision), result = recover(source);
  assert.equal(result.branchesFolded, 1);
  assert.equal(result.source, source.replace(decision, 'value = (probe()) ? left : right;'));
  assert.deepEqual(recover(result.source), {source: result.source, branchesFolded: 0});
});

test('retains the predicate once and numeric literal spelling exactly', () => {
  const source = 'while(again()) { if ((flag=probe()) && tick()) { value=0x8000_0000; } else { value=-2147483648; } }';
  assert.equal(recover(source).source, 'while(again()) { value = ((flag=probe()) && tick()) ? 0x8000_0000 : -2147483648; }');
});

test('many independent decisions retain order without iterative whole-source rewriting', () => {
  const decisions=Array.from({length:1000},(_,i)=>`if(probe(${i})) { value=${i}; } else { value=-${i}; }`);
  const result=recover(decisions.join('\n'));
  assert.equal(result.branchesFolded,1000);
  assert.equal(result.source,Array.from({length:1000},(_,i)=>`value = (probe(${i})) ? ${i} : -${i};`).join('\n'));
});

for (const [name, source] of [
  ['unqualified field', 'if(probe()) { field=left; } else { field=right; }'],
  ['qualified field', 'if(probe()) { this.value=left; } else { this.value=right; }'],
  ['array store', 'if(probe()) { array[0]=left; } else { array[0]=right; }'],
  ['effectful arm', 'if(probe()) { value=work(); } else { value=right; }'],
  ['extra work', 'if(probe()) { work(); value=left; } else { value=right; }'],
  ['different destinations', 'if(probe()) { value=left; } else { left=right; }'],
  ['compound store', 'if(probe()) { value+=left; } else { value=right; }'],
  ['cast', 'if(probe()) { value=(int)left; } else { value=right; }'],
  ['inline destination', 'for(int value=0;value<3;value++) { if(probe()) { value=left; } else { value=right; } }'],
  ['inline operand', 'try { work(); } catch(RuntimeException left) { if(probe()) { value=left; } else { value=right; } }'],
  ['lambda capture', 'Runnable r=()->{ if(probe()) { value=left; } else { value=right; } };'],
  ['anonymous class', 'Object x=new Object(){int left;void run(){if(probe()){value=left;}else{value=right;}}};'],
  ['comment', 'if(probe()) { value=left; /* keep explanation */ } else { value=right; }'],
  ['translated unicode', 'if(probe()) { value=le\\u0066t; } else { value=right; }'],
  ['missing else', 'if(probe()) { value=left; }'],
  ['malformed syntax', 'if('],
]) test(`refuses an unproven ${name}`, () => {
  assert.deepEqual(recover(source), {source, branchesFolded: 0});
});

test('refuses numeric promotion, narrowing and references', () => {
  for (const entries of [
    [['value','long'],['left','int'],['right','long']],
    [['value','byte'],['left','byte'],['right','int']],
    [['value','int'],['left','Integer'],['right','Integer']],
    [['value','Object'],['left','Object'],['right','Object']],
  ]) {
    const source = `while(again()) { ${decision} }`, known = new Map(entries);
    assert.deepEqual(foldPrimitiveValueBranches(source,{localType:name=>known.get(name)}), {source,branchesFolded:0});
  }
  const source='if(probe()) { value=1; } else { value=0; }';
  assert.deepEqual(foldPrimitiveValueBranches(source,{localType:()=> 'byte'}), {source,branchesFolded:0});
  assert.deepEqual(foldPrimitiveValueBranches(source), {source,branchesFolded:0});
});

test('source replay proves scoped primitive declarations without a caller type table', () => {
  for (const [type, a, b] of [
    ['int','left*31+value','right^value'], ['long','left+1L','right-1L'],
    ['float','-left','right*0x1.000002p0f'], ['double','left+1e300','-right'],
    ['byte','left','right'], ['short','left','right'], ['char',"'a'","'z'"],
    ['boolean','!left','right|left'],
  ]) {
    const zero=type==='boolean'?'false':'0';
    const source=`${type} left=${zero},right=${zero},value=${zero};if(probe()){value=${a};}else{value=${b};}use(value);`;
    const result=foldPrimitiveValueBranches(source);
    assert.equal(result.branchesFolded,1,source);
    assert.equal(result.source,source.replace(`if(probe()){value=${a};}else{value=${b};}`,`value = (probe()) ? (${a}) : (${b});`));
    assert.equal(foldPrimitiveValueBranches(result.source).source,result.source);
  }
  const source='final int value;try{synchronized(lock){if((flag=read())!=0&&boxed){value=2147483647;}else{value=-2147483648;}}}finally{done();}';
  assert.equal(foldPrimitiveValueBranches(source).branchesFolded,1);
  const nested='int value=0;if(first()){use();}else if(second()){value=3;}else{value=5;}';
  assert.equal(foldPrimitiveValueBranches(nested).source,nested);
  const wrapped='double value=0;int a=1,b=2;if(first()){value=1.0;}else{if(second()){value=2.0;}else{value=3.0;}}';
  assert.equal(foldPrimitiveValueBranches(wrapped).source,wrapped);
  const loop='int value=0;while(again())if(test()){value=1;}else{value=2;}';
  assert.equal(foldPrimitiveValueBranches(loop).source,'int value=0;while(again()){\nvalue = (test()) ? (1) : (2);\n}');
});

test('source replay refuses shadowing, widened conversions, fields and unproven operands', () => {
  for(const source of [
    'int value=0,left=1;long right=2;if(probe()){value=left;}else{value=right;}',
    'long value=0;int left=1,right=2;if(probe()){value=left;}else{value=right;}',
    'byte value=0;if(probe()){value=1;}else{value=2;}',
    'Integer value=0;if(probe()){value=1;}else{value=2;}',
    'int value=0;if(probe()){value=other;}else{value=2;}',
    '{int value=0;}if(probe()){value=1;}else{value=2;}',
    'int value=0;{int value=1;}if(probe()){value=1;}else{value=2;}',
    'for(int value=0;again();value++){if(probe()){value=1;}else{value=2;}}',
    'int value=0;if(probe()){value=this.field;}else{value=2;}',
    'int value=0;if(probe()){this.value=1;}else{this.value=2;}',
    'int value=0;if(probe()){value=read();}else{value=2;}',
    'int value=0,divisor=read();if(probe()){value=1/divisor;}else{value=2;}',
    'int value=0;if(probe()){value=1;}else{value=2;}Object nested=new Object(){};',
    'int value=0;if(probe()){value=1;}else{value=2;}Runnable r=Owner::run;',
    'int value=0;if(probe()){value=1;hit();}else{value=2;}',
    'int value=0;if(probe()){value=1;/*keep*/}else{value=2;}',
    'int value=0;if(probe()){value=1;}else{value=2;}\\u000a',
    'int value=0;if(probe()){value=1;}else{value=2;}'+' '.repeat(400001),
  ]) assert.equal(foldPrimitiveValueBranches(source).source,source,source);
});

test('source replay preserves native primitive bits, predicate effects and protected completion', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'scoped-value-native-'));
  const models=[
    ['int','0','Integer.MIN_VALUE','Integer.MAX_VALUE','left+value','right-value'],
    ['long','0L','9007199254740993L','-9007199254740993L','left+value','right-value'],
    ['float','0.0f','Float.intBitsToFloat(0x7fc01234)','-0.0f','left','right'],
    ['double','0.0d','Double.longBitsToDouble(0x7ff8000000001234L)','-0.0d','left','right'],
    ['byte','0','(byte)-128','(byte)127','left','right'],
    ['short','0','(short)-32768','(short)32767','left','right'],
    ['char',"'\\0'","'\\0'","'\\uffff'",'left','right'],
    ['boolean','false','false','true','!left','right^value'],
  ];
  const contexts=[s=>s,s=>`synchronized(monitor){trace.append('L');${s}}`,
    s=>`try{${s}}finally{trace.append('F').append(tag(value));if(mode==1)return tag(value);if(mode==2)throw OVERRIDE;}`,
    s=>`try{synchronized(monitor){trace.append('L');${s}}}catch(IllegalStateException failure){trace.append(failure==FAILURE?'C':'X');}finally{trace.append('F').append(tag(value));}`];
  try {
    let methods='',checks='';
    for(const [i,[type,zero,a,b,yes,no]]of models.entries())for(const [context,wrap]of contexts.entries()){
      const decision=`if(probe(flag,inject)){value=${yes};}else{value=${no};}`;
      const declaration=`${type} left=a,right=b,value=${zero};`;
      const old=declaration+wrap(`for(int index=0;index<2;index++){${decision}trace.append('A').append(tag(value));}`)+'return tag(value);';
      const next=foldPrimitiveValueBranches(old);assert.equal(next.branchesFolded,1,old);
      const oracle=declaration+wrap(`for(int index=0;index<2;index++){boolean selected=probe(flag,inject);${type}[] options=new ${type}[]{${no},${yes}};value=options[selected?1:0];trace.append('A').append(tag(value));}`)+'return tag(value);';
      for(const [prefix,body]of [['old',old],['next',next.source],['oracle',oracle]])
        methods+=`static String ${prefix}${i}_${context}(Boolean flag,int inject,int mode,Object monitor,${type} a,${type} b){${body}}\n`;
      checks+=`for(int swap=0;swap<2;swap++){String expected=take(${i},${context},2,flag,inject,mode,monitor,swap);for(int variant=0;variant<2;variant++){String actual=take(${i},${context},variant,flag,inject,mode,monitor,swap);if(!expected.equals(actual))throw new AssertionError(${i}+":"+${context}+":"+variant+":"+expected+" != "+actual);}cases++;}`;
    }
    const fixture=`class ScopedValueNative {
      static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException("probe"),OVERRIDE=new IllegalArgumentException("finally");
      static boolean probe(Boolean flag,int inject){trace.append('P');if(inject==1)throw FAILURE;boolean result=flag;trace.append(result?'T':'N');return result;}
      static String tag(int v){return "i"+v;}static String tag(long v){return "l"+v;}
      static String tag(float v){return "f"+Float.floatToRawIntBits(v);}static String tag(double v){return "d"+Double.doubleToRawLongBits(v);}
      static String tag(byte v){return "b"+v;}static String tag(short v){return "s"+v;}static String tag(char v){return "c"+(int)v;}static String tag(boolean v){return "z"+v;}
      ${methods}
      static String take(int model,int context,int variant,Boolean flag,int inject,int mode,Object monitor,int swap){trace=new StringBuilder();String value;try{switch(model*4+context){
      ${models.flatMap(([type,zero,a,b],i)=>contexts.map((_,context)=>`case ${i*4+context}:value=variant==0?old${i}_${context}(flag,inject,mode,monitor,swap==0?${a}:${b},swap==0?${b}:${a}):variant==1?next${i}_${context}(flag,inject,mode,monitor,swap==0?${a}:${b},swap==0?${b}:${a}):oracle${i}_${context}(flag,inject,mode,monitor,swap==0?${a}:${b},swap==0?${b}:${a});break;`)).join('\n')}
      default:throw new AssertionError();}}catch(Throwable failure){value=failure==FAILURE?"probe":failure==OVERRIDE?"finally":failure.getClass().getName();}
      if(monitor!=null&&Thread.holdsLock(monitor))throw new AssertionError("monitor leaked");return value+":"+trace;}
      public static void main(String[] args){int cases=0;for(Boolean flag:new Boolean[]{false,true,null})for(int inject=0;inject<2;inject++)for(int mode=0;mode<3;mode++)for(Object monitor:new Object[]{null,new Object()}){${checks}}System.out.println("cases:"+cases);}
    }`;
    fs.writeFileSync(path.join(temporary,'ScopedValueNative.java'),fixture);
    run('javac',['--release','8','ScopedValueNative.java'],temporary);
    assert.equal(run('java',['-Xverify:all','-XX:-OmitStackTraceInFastThrow','-cp',temporary,'ScopedValueNative'],temporary),'cases:2304');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

function run(command,args,cwd) {
  const result=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr||result.error?.stack||result.stdout);
  return result.stdout.trim();
}

test('native differential preserves primitive type, bits, exceptions, effects and monitor release', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'primitive-value-native-'));
  try {
    const variants=[
      ['int','0','Integer.MIN_VALUE','Integer.MAX_VALUE'],
      ['long','0L','Long.MIN_VALUE','Long.MAX_VALUE'],
      ['float','0.0f','Float.intBitsToFloat(0x7fc01234)','-0.0f'],
      ['double','0.0d','Double.longBitsToDouble(0x7ff8000000001234L)','-0.0d'],
      ['byte','(byte)0','Byte.MIN_VALUE','Byte.MAX_VALUE'],
      ['short','(short)0','Short.MIN_VALUE','Short.MAX_VALUE'],
      ['char',"'\\0'","'\\0'","'\\uffff'"],
      ['boolean','false','true','false'],
    ];
    const methods=[],checks=[];
    for(const [ordinal,[type,zero,left,right]] of variants.entries()) {
      const source=`try { synchronized(monitor) { for(int index=0;index<2;index++) {
        if(predicate(flag,mode)) { value=left; } else { value=right; }
        trace.append(tag(value)).append(';');
      } } } catch(Throwable failure) { trace.append(failure==specific?"specific":failure.getClass().getName()); }
      finally { trace.append(':').append(tag(value)).append(':').append(Thread.holdsLock(lock)); }`;
      const known=new Map([['value',type],['left',type],['right',type]]);
      const rebuilt=foldPrimitiveValueBranches(source,{localType:name=>known.get(name)});
      assert.equal(rebuilt.branchesFolded,1);
      for(const [prefix,body] of [['original',source],['rebuilt',rebuilt.source]])
        methods.push(`static String ${prefix}${ordinal}(Boolean flag,${type} left,${type} right,int mode,boolean nullLock) {
          ${type} value=${zero};trace.setLength(0);Object monitor=nullLock?null:lock;${body}return trace.toString();}`);
      for(const [a,b] of [[left,right],[right,left]])checks.push(`{
        String expected=original${ordinal}(flag,${a},${b},mode,nullLock),actual=rebuilt${ordinal}(flag,${a},${b},mode,nullLock);
        if(!expected.equals(actual))throw new AssertionError(${ordinal}+":"+expected+" != "+actual);cases++;}`);
    }
    fs.writeFileSync(path.join(temporary,'PrimitiveValueNative.java'),`class PrimitiveValueNative {
      static final Object lock=new Object();static final StringBuilder trace=new StringBuilder();
      static final RuntimeException specific=new IllegalArgumentException("specific");
      static boolean predicate(Boolean flag,int mode){trace.append('p').append(Thread.holdsLock(lock));if(mode==1)throw specific;return flag;}
      static String tag(int v){return "i"+v;}static String tag(long v){return "l"+v;}
      static String tag(float v){return "f"+Float.floatToRawIntBits(v);}static String tag(double v){return "d"+Double.doubleToRawLongBits(v);}
      static String tag(byte v){return "b"+v;}static String tag(short v){return "s"+v;}static String tag(char v){return "c"+(int)v;}static String tag(boolean v){return "z"+v;}
      ${methods.join('\n')}
      public static void main(String[] args){int cases=0;for(Boolean flag:new Boolean[]{true,false,null})for(int mode=0;mode<2;mode++)for(boolean nullLock:new boolean[]{false,true}){${checks.join('\n')}}System.out.println("cases:"+cases);}
    }`);
    run('javac',['PrimitiveValueNative.java'],temporary);
    assert.equal(run('java',['-cp',temporary,'PrimitiveValueNative'],temporary),'cases:192');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('default decompilation folds primitive value branches inside loops', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'primitive-value-default-'));
  try {
    const original=path.join(temporary,'original'),rebuilt=path.join(temporary,'rebuilt');fs.mkdirSync(original);fs.mkdirSync(rebuilt);
    fs.writeFileSync(path.join(original,'PrimitiveValueDefault.java'),`class PrimitiveValueDefault {
      static int pick(int count,boolean flag){int value=0,sum=0;for(int index=0;index<count;index++){${'if(flag){value=3;}else{value=5;}sum|=value;'.repeat(16)}}return sum;}
      public static void main(String[] args){for(int count=0;count<8;count++)for(boolean flag:new boolean[]{false,true})System.out.println(pick(count,flag));}
    }`);
    run('javac',['--release','8','PrimitiveValueDefault.java'],original);
    const diagnostics=[],source=decompileClassFile(path.join(original,'PrimitiveValueDefault.class'),{diagnostics});
    assert.deepEqual(diagnostics,[]);assert.equal((source.match(/\? (?:3 : 5|5 : 3)/g)||[]).length,16);
    fs.writeFileSync(path.join(rebuilt,'PrimitiveValueDefault.java'),source);
    run('javac',['--release','8','PrimitiveValueDefault.java'],rebuilt);
    assert.equal(run('java',['-cp',rebuilt,'PrimitiveValueDefault'],rebuilt),run('java',['-cp',original,'PrimitiveValueDefault'],original));
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});
