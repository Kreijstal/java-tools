'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');

function run(command,args,directory) {
  const files=['stdout','stderr'].map(name=>path.join(directory,name));
  const fds=files.map(file=>fs.openSync(file,'w'));
  try {
    const result=spawnSync(command,args,{stdio:['ignore',...fds],timeout:15000,
      env:{...process.env,JAVA_TOOL_OPTIONS:'-XX:-UsePerfData'}});
    if(result.error) throw result.error;
    assert.equal(result.status,0,fs.readFileSync(files[1],'utf8'));
    return fs.readFileSync(files[0],'utf8');
  } finally {fds.forEach(fd=>fs.closeSync(fd));}
}

test('nested numeric negation preserves values, locals, literal boundaries and effect order',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-numeric-negation-'));
  const previous=process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const native=path.join(temporary,'native');fs.mkdirSync(native);
    const cases=[['int','I','i',1],['long','J','l',2],['float','F','f',1],['double','D','d',2]];
    let assembly='.version 49 0\n.class public super NumericNegation\n.super java/lang/Object\n';
    for(const [name,descriptor,opcode,slots] of cases) for(const count of [2,3,4]) {
      assembly+=`.method public static ${name}${count} : (${descriptor})${descriptor}
        .code stack ${slots*2} locals ${slots*2}
        ${opcode}load_0
        ${Array(count).fill(opcode+'neg').join('\n')}
        ${opcode}store ${slots}
        ${opcode}load ${slots}
        ${opcode}return
      .end code
    .end method\n`;
    }
    assembly+=`.method public static parameterStillIntact : (I)I
      .code stack 2 locals 2
      iload_0
      ineg
      ineg
      istore_1
      iload_0
      bipush 31
      imul
      iload_1
      iadd
      ireturn
    .end code
    .end method
    .method public static effects : ()I
      .code stack 1 locals 0
      invokestatic Method Effects next ()I
      ineg
      ineg
      ireturn
    .end code
    .end method
    .method public static negativeIntLiteral : ()I
      .code stack 1 locals 0
      bipush -7
      ineg
      ireturn
    .end code
    .end method
    .method public static negativeLongLiteral : ()J
      .code stack 2 locals 0
      ldc2_w -7L
      lneg
      lreturn
    .end code
    .end method
    .method public static actualDecrement : (I)I
      .code stack 1 locals 1
      iinc 0 -1
      iload_0
      ireturn
    .end code
    .end method\n`;
    const classFile=path.join(native,'NumericNegation.class');
    assembly+='\n.end class';
    assembleJasminSource(assembly,classFile);
    const effects=`class Effects { static int calls; static boolean fail;
      static int next() { calls++; if(fail) throw new IllegalArgumentException(); return -7; } }`;
    const driver=`class NegationRunner { public static void main(String[] args) {
      for(int count:new int[]{2,3,4}) {
        for(int value:new int[]{Integer.MIN_VALUE,Integer.MIN_VALUE+1,-7,-1,0,1,7,Integer.MAX_VALUE})
          System.out.println(count+":i:"+(count==2?NumericNegation.int2(value):
            count==3?NumericNegation.int3(value):NumericNegation.int4(value)));
        for(long value:new long[]{Long.MIN_VALUE,Long.MIN_VALUE+1,-7,-1,0,1,7,Long.MAX_VALUE})
          System.out.println(count+":l:"+(count==2?NumericNegation.long2(value):
            count==3?NumericNegation.long3(value):NumericNegation.long4(value)));
        for(int bits:new int[]{0,Integer.MIN_VALUE,1,-1,0x7f800000,0xff800000,0x7fc01234,
          0xffc01234,0x3f800000,0xbf800000,0x7f7fffff,0xff7fffff}) {
          float value=Float.intBitsToFloat(bits);
          System.out.println(count+":f:"+Float.floatToRawIntBits(count==2?NumericNegation.float2(value):
            count==3?NumericNegation.float3(value):NumericNegation.float4(value)));
        }
        for(long bits:new long[]{0,Long.MIN_VALUE,1,-1,0x7ff0000000000000L,0xfff0000000000000L,
          0x7ff8000000001234L,0xfff8000000001234L,0x3ff0000000000000L,0xbff0000000000000L,
          0x7fefffffffffffffL,0xffefffffffffffffL}) {
          double value=Double.longBitsToDouble(bits);
          System.out.println(count+":d:"+Double.doubleToRawLongBits(count==2?NumericNegation.double2(value):
            count==3?NumericNegation.double3(value):NumericNegation.double4(value)));
        }
      }
      for(int value:new int[]{Integer.MIN_VALUE,-7,-1,0,1,7,Integer.MAX_VALUE}) {
        System.out.println("unchanged:"+NumericNegation.parameterStillIntact(value));
        System.out.println("decrement:"+NumericNegation.actualDecrement(value));
      }
      Effects.calls=0; System.out.println("effects:"+NumericNegation.effects()+":"+Effects.calls);
      Effects.calls=0; Effects.fail=true;
      try { NumericNegation.effects(); throw new AssertionError("exception missing"); }
      catch(IllegalArgumentException error) { System.out.println("exception:"+Effects.calls); }
      System.out.println("literal:"+NumericNegation.negativeIntLiteral()+":"+NumericNegation.negativeLongLiteral());
    } }`;
    for(const [name,source] of Object.entries({Effects:effects,NegationRunner:driver}))
      fs.writeFileSync(path.join(native,name+'.java'),source);
    run('javac',['--release','8','-classpath',native,'-d',native,
      path.join(native,'Effects.java'),path.join(native,'NegationRunner.java')],native);
    const expected=run('java',['-cp',native,'NegationRunner'],native);
    assert.equal(expected.trim().split('\n').length,137);
    for(const forced of [false,true]) {
      if(forced) process.env.CFR_JS_FORCE_STATE_MACHINE='1';
      else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const source=decompileClassFile(classFile);assertNoFallback(source);
      assert.doesNotMatch(source,/--param0|--2147483648|--9223372036854775808/);
      const rebuilt=path.join(temporary,forced?'forced':'structured');fs.mkdirSync(rebuilt);
      for(const [name,text] of Object.entries({NumericNegation:source,Effects:effects,NegationRunner:driver}))
        fs.writeFileSync(path.join(rebuilt,name+'.java'),text);
      run('javac',['--release','8','-d',rebuilt,...['NumericNegation','Effects','NegationRunner']
        .map(name=>path.join(rebuilt,name+'.java'))],rebuilt);
      assert.equal(run('java',['-cp',rebuilt,'NegationRunner'],rebuilt),expected);
    }
  } finally {
    if(previous===undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE=previous;
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
