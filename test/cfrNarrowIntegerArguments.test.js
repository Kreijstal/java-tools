'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const JSZip = require('jszip');
const {getAST} = require('jvm_parser');
const {convertJson} = require('../src/parsing/convert_tree');
const {parseDescriptor} = require('../src/parsing/typeParser');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompilePath,decompileAstRoot,buildExceptionModel,_internals:ir,assertNoFallback} = require('../src/decompiler/cfr');

function run(command,args,directory) {
  const files=['stdout','stderr'].map(name=>path.join(directory,name));
  const fds=files.map(file=>fs.openSync(file,'w'));
  try {
    const result=spawnSync(command,args,{stdio:['ignore',...fds],timeout:20000,
      env:{...process.env,JAVA_TOOL_OPTIONS:'-XX:-UsePerfData'}});
    if(result.error)throw result.error;
    assert.equal(result.status,0,fs.readFileSync(files[1],'utf8'));
    return fs.readFileSync(files[0],'utf8');
  }finally{fds.forEach(fd=>fs.closeSync(fd));}
}

test('owned static narrow parameters preserve full JVM integers carried through branches',async()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-narrow-int-args-'));
  try {
    const native=path.join(temporary,'native');fs.mkdirSync(native);
    let target='.version 49 0\n.class public super ATarget\n.super java/lang/Object\n';
    let caller='.version 49 0\n.class public super ZCaller\n.super java/lang/Object\n';
    for(const [name,type] of [['takeByte','B'],['takeShort','S'],['takeChar','C']]){
      target+=`.method public static ${name==='takeShort'?'synchronized ':''}${name} : (${type})I
        .code stack 2 locals 1
        iload_0
        bipush 22
        if_icmpne Lother
        iconst_1
        ireturn
      Lother:
        iload_0
        ireturn
        .end code
      .end method\n`;
      caller+=`.method public static ${name} : (II)I
        .code stack 2 locals 2
        .catch java/lang/RuntimeException from Lstart to Lend using Lcatch
      Lstart:
        iload_0
        iload_1
        ifeq Ljoin
        bipush 31
        iadd
      Ljoin:
        invokestatic Method ATarget ${name} (${type})I
      Lend:
        ireturn
      Lcatch:
        athrow
        .end code
      .end method\n`;
    }
    target+='\n.end class';caller+='\n.end class';
    for(const [name,source] of Object.entries({ATarget:target,ZCaller:caller}))
      assembleJasminSource(source,path.join(native,name+'.class'));
    const driver=`class NarrowRunner { public static void main(String[]args) {
      int cases=0;
      for(int value:new int[]{Integer.MIN_VALUE,-65537,-32769,-32768,-8170,-257,-129,-128,-1,0,1,22,127,128,255,256,278,32767,32768,65535,65536,Integer.MAX_VALUE})
      for(int flag:new int[]{-1,0,1}) {
        System.out.println(value+":"+flag+":"+ZCaller.takeByte(value,flag)+":"+ZCaller.takeShort(value,flag)+":"+ZCaller.takeChar(value,flag));cases++;
      }
      if(cases!=66)throw new AssertionError(cases);
      System.out.println("canonical:"+ATarget.takeByte((byte)22)+":"+ATarget.takeShort((short)-1)+":"+ATarget.takeChar((char)65535));
    } }`;
    fs.writeFileSync(path.join(native,'NarrowRunner.java'),driver);
    run('javac',['--release','8','-cp',native,'-d',native,path.join(native,'NarrowRunner.java')],native);
    const expected=run('java',['-cp',native,'NarrowRunner'],native);
    assert.match(expected,/-8170:0:-8170:-8170:-8170/);
    // Exclude the driver from the decompiler input. Its ordinary Java casts are
    // deliberate; the assembled callers contain no i2b/i2s/i2c instruction.
    fs.unlinkSync(path.join(native,'NarrowRunner.class'));
    const zip=new JSZip();for(const name of ['ATarget','ZCaller'])zip.file(name+'.class',fs.readFileSync(path.join(native,name+'.class')));
    const jar=path.join(temporary,'input.jar');fs.writeFileSync(jar,await zip.generateAsync({type:'nodebuffer'}));
    const astClasses=['ATarget','ZCaller'].flatMap(name=>{
      const parsed=getAST(new Uint8Array(fs.readFileSync(path.join(native,name+'.class'))));
      return convertJson(parsed.ast,parsed.constantPool).classes;
    });
    for(const [mode,input] of [['directory',native],['jar',jar],['ast',null]]){
      let outputs;
      if(mode==='ast') {
        const diagnostics=[];
        const text=decompileAstRoot({classes:astClasses},{diagnostics,omitHeader:true});
        const boundary=text.indexOf('public class ZCaller');
        assert.ok(boundary>0);
        outputs=[{name:'ATarget.java',source:text.slice(0,boundary),diagnostics},
          {name:'ZCaller.java',source:text.slice(boundary),diagnostics:[]}];
      }else outputs=await decompilePath(input);
      assert.equal(outputs.length,2);
      const rebuilt=path.join(temporary,mode);fs.mkdirSync(rebuilt);
      for(const output of outputs){assertNoFallback(output.source);fs.writeFileSync(path.join(rebuilt,output.name),output.source);}
      const targetOutput=outputs.find(output=>output.name==='ATarget.java');
      assert.equal((targetOutput.source.match(/\/\* Full JVM integer arguments/g)||[]).length,3);
      assert.match(targetOutput.source,/takeByte\(byte param0\)/);
      assert.equal(targetOutput.diagnostics.filter(item=>item.kind==='intArgumentBridge').length,3);
      if(mode!=='ast'){const second=await decompilePath(input);assert.deepEqual(second,outputs,'deterministic output without state leaking between exports');}
      fs.writeFileSync(path.join(rebuilt,'NarrowRunner.java'),driver);
      run('javac',['--release','8','-d',rebuilt,...['ATarget','ZCaller','NarrowRunner'].map(name=>path.join(rebuilt,name+'.java'))],rebuilt);
      assert.equal(run('java',['-cp',rebuilt,'NarrowRunner'],rebuilt),expected,mode+' preserves all 201 printed invocation results');
    }
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('integer entry points retain array/reference descriptors and refuse unsupported targets',()=>{
  const method={name:'f',descriptor:'([BBLSomeByteClass;[SSC)B',flags:['static'],
    attributes:[{type:'code',code:{codeItems:[]}}]};
  const cls={className:'Owner',flags:[],items:[{type:'method',method}]};
  const ref={owner:'Owner',name:'f',descriptor:method.descriptor};
  const descriptor=parseDescriptor(ref.descriptor);
  const args=descriptor.params.map((type,index)=>({type:index===1?'int':type,code:index===1?'stackIn_4_0':'value'+index}));
  const model=buildExceptionModel([cls]);
  const bridge=ir.intArgumentBridgeForCall(ref,descriptor,args,model,'Caller');
  assert.equal(bridge.descriptor,'([BILSomeByteClass;[SII)B');
  assert.deepEqual([...model.intArgumentBridgeDirtyOwners],['Caller','Owner']);
  assert.equal(ir.intArgumentBridgeForCall(ref,descriptor,args,model,'Caller'),bridge);
  const collided={...cls,items:[...cls.items,{type:'method',method:{name:bridge.name}}]};
  assert.equal(ir.intArgumentBridgeForCall(ref,descriptor,args,buildExceptionModel([collided]),'Caller').name,bridge.name+'$');
  for(const flags of [[],['static','native'],['static','abstract']])
    assert.equal(ir.intArgumentBridgeForCall(ref,descriptor,args,buildExceptionModel([{...cls,items:[{type:'method',method:{...method,flags}}]}]),'Caller'),null);
  for(const flags of [['interface'],['enum']])
    assert.equal(ir.intArgumentBridgeForCall(ref,descriptor,args,buildExceptionModel([{...cls,flags}]),'Caller'),null);
  assert.equal(ir.intArgumentBridgeForCall(ref,descriptor,args,buildExceptionModel([]),'Caller'),null);
  for(const value of [{type:'byte',code:'stackIn_4_0'},{type:'int',code:'22'},{type:'int',code:'ordinaryInt'}]) {
    const replaced=args.map((arg,index)=>index===1?value:arg);
    assert.equal(ir.intArgumentBridgeForCall(ref,descriptor,replaced,buildExceptionModel([cls]),'Caller'),null);
  }
});
