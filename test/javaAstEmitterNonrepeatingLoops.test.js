'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {foldNonrepeatingWhileLoops: fold} = require('../src/decompiler/javaAstEmitter');

test('nonrepeating while changes only its keyword, retaining scopes and scalar parents', () => {
  for (const source of [
    'while(pick){int value=7;return value;}return 9;',
    'if(outer)while(pick){return 7;}else other();return 9;',
    'Exit:while(pick){if(stop)break Exit;return 7;}return 9;',
    'Rounds:for(int n=0;n<2;n++){while(pick){if(stop)continue Rounds;return 7;}finish();}return 9;',
  ]) {
    const result=fold(source,{parameterNames:['pick','outer','stop'],retainDiagnostics:true});
    assert.equal(result.conditionalsRecovered,1);
    const {start,end}=result.diagnostics.headerKeywordRange;
    assert.equal(source.slice(start,end),'while');
    assert.equal(result.source,source.slice(0,start)+'if'+source.slice(end));
    assert.equal(fold(result.source,{parameterNames:['pick','outer','stop']}).conditionalsRecovered,0);
  }
});

test('inner transfers are consumed at their own destinations before testing the whole body', () => {
  const result=fold('while(pick){Inner:while(true){if(stop)break Inner;return 1;}return 2;}return 3;', {parameterNames:['pick','stop']});
  assert.equal(result.conditionalsRecovered,1);
  assert.match(result.source,/^if\(pick\)\{Inner:while/);
  assert.equal(fold('while(pick){switch(code){case 1:break;default:return 1;}return 2;}return 3;', {parameterNames:['pick','code']}).conditionalsRecovered,1);
  for(const body of ['Inner:while(true){if(stop)break Inner;return 1;}',
    'switch(code){case 1:break;default:return 1;}', 'if(stop)return 1;', 'step();']) {
    const source='while(pick){'+body+'}return 3;';
    assert.equal(fold(source,{parameterNames:['pick','stop','code']}).source,source);
  }
});

test('protected completion retains all catches, finally overrides and monitor ownership', () => {
  for(const body of [
    'try{return first();}catch(RuntimeException error){throw error;}finally{cleanup();}',
    'try{step();}finally{return last();}',
    'synchronized(lock){return first();}',
    'try{if(stop)break Exit;return first();}finally{cleanup();if(other)break Exit;}',
  ]) {
    const source='Exit:while(pick){'+body+'}return 3;';
    const result=fold(source,{parameterNames:['pick','stop','other','lock']});
    assert.equal(result.conditionalsRecovered,1,source);
    assert.equal(result.source,source.replace('while','if'));
  }
  for(const body of [
    'try{return first();}catch(RuntimeException error){step();}',
    'try{step();}finally{if(stop)return first();}',
    'try{return first();}finally{if(stop)continue Exit;}',
    'try{continue Exit;}finally{return first();}',
  ]) {
    const source='Exit:while(pick){'+body+'}return 3;';
    assert.equal(fold(source,{parameterNames:['pick','stop']}).source,source);
  }
});

test('own backedges, bare breaks, constants, ambiguity and unsupported syntax refuse conversion', () => {
  for(const source of [
    'while(pick){if(stop)break;return 1;}return 2;',
    'Exit:while(pick){if(stop)continue;return 1;}return 2;',
    'Exit:while(pick){while(true){if(stop)continue Exit;return 1;}}return 2;',
    'while(true){return 1;}',
    'final boolean pick=true;while(pick){return 1;}',
    'while(Holder.CONSTANT){return 1;}return 2;',
    'while(pick)return 1;return 2;',
    'Exit:while(pick){return 1;}Exit:{return 2;}',
    'while(pick){break Missing;}return 2;',
    'while(pick){return 1;} // comment\nreturn 2;',
    'while(pick){return 1;}\\u000a return 2;',
    'while(pick){Runnable task=()->step();return 1;}return 2;',
    'while(pick){class Local{}return 1;}return 2;',
    'while(pick){1+2;return 1;}return 2;',
    'while(pick){step() return 1;}return 2;',
  ]) assert.equal(fold(source,{parameterNames:['pick','stop']}).source,source,source);
  const source='while(pick){return 1;}return 2;';
  for(const options of [{parameterNames:['pick','pick']},{parameterNames:['bad-name']},{retainDiagnostics:'yes'}])
    assert.deepEqual(fold(source,options),{source,conditionalsRecovered:0});
});

test('nonrepeating loops match native execution and 512 independent event-model cases', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nonrepeating-loop-native-'));
  const run=(command,args)=>{
    const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:8*1024*1024});
    assert.equal(result.status,0,result.stderr||result.stdout);return result.stdout;
  };
  try {
    const bodies=[
      'return done(action(mode,t),t);',
      'if(mode==11)break Exit;return done(action(mode,t),t);',
      'try{return done(action(mode,t),t);}finally{cleanup(mode,t);if(mode==12)return done(99,t);}',
      'try{return done(action(mode,t),t);}catch(Specific failure){t.append("S");return done(70,t);}catch(RuntimeException failure){t.append("R");throw failure;}',
      'synchronized(lock){t.append("L");return done(action(mode,t),t);}',
      'int value=action(mode,t);Inner:while(true){if(mode==13){t.append("I");break Inner;}return done(value,t);}return done(value+1,t);',
      'try{synchronized(lock){t.append("L");return done(action(mode,t),t);}}finally{cleanup(mode,t);if(mode==12)break Exit;}',
      'int value=action(mode,t);if(mode==14)continue Rounds;if(mode==15)break Exit;return done(value,t);',
    ];
    let methods='';
    for(const [variant,body] of bodies.entries()) {
      let source='StringBuilder t=trace=new StringBuilder();Exit:while(gate(choose,mode,t)){'+body+'}t.append("T");return done(31,t);';
      if(variant==7)source='StringBuilder t=trace=new StringBuilder();int total=0;Rounds:for(int round=0;round<2;round++){t.append("Q");Exit:while(gate(choose,mode,t)){'+body+'}t.append("T");total+=31;}return done(total,t);';
      const result=fold(source,{parameterNames:['choose','mode','lock']});
      assert.equal(result.conditionalsRecovered,1,'variant'+variant);
      methods+='static String old'+variant+'(boolean choose,int mode,Object lock){'+source+'}\n';
      methods+='static String next'+variant+'(boolean choose,int mode,Object lock){'+result.source+'}\n';
    }
    const fixture=`public class NonrepeatingLoops {
      static class Specific extends RuntimeException{} static class General extends RuntimeException{}
      static final Specific SPECIFIC=new Specific();static final General GENERAL=new General();static final Error FATAL=new Error();
      static StringBuilder trace;
      static Boolean gate(boolean choose,int mode,StringBuilder t){t.append("G");if(mode==1)throw SPECIFIC;if(mode==2)throw GENERAL;if(mode==3)throw FATAL;if(mode==4)return null;return choose;}
      static int action(int mode,StringBuilder t){t.append("B");if(mode==5)throw SPECIFIC;if(mode==6)throw GENERAL;if(mode==7)throw FATAL;return 23;}
      static void cleanup(int mode,StringBuilder t){t.append("F");if(mode==8)throw SPECIFIC;if(mode==9)throw GENERAL;if(mode==10)throw FATAL;}
      static String done(int value,StringBuilder t){return value+":"+t;}
      ${methods}
      static String invoke(boolean next,int variant,boolean choose,int mode,Object lock){try {
        switch(variant){${bodies.map((_,v)=>'case '+v+':return next?next'+v+'(choose,mode,lock):old'+v+'(choose,mode,lock);').join('')}}throw new AssertionError();
      }catch(Throwable failure){if(failure==SPECIFIC)return "error:S";if(failure==GENERAL)return "error:R";if(failure==FATAL)return "error:E";if(failure instanceof NullPointerException)return "error:N";throw new AssertionError(failure);}}
      public static void main(String[] args){boolean next=args[0].equals("next");for(int v=0;v<8;v++)for(int choose=0;choose<2;choose++)for(int mode=0;mode<16;mode++)for(int lockKind=0;lockKind<2;lockKind++){
        Object lock=lockKind==0?null:new Object();String result=invoke(next,v,choose==1,mode,lock);
        if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor retained");
        System.out.println(v+","+choose+","+mode+","+lockKind+"|"+result+"|"+trace);
      }}
    }`;
    const file=path.join(temporary,'NonrepeatingLoops.java');fs.writeFileSync(file,fixture);
    run('javac',['--release','8','-d',temporary,file]);
    const original=run('java',['-cp',temporary,'NonrepeatingLoops','old']);
    const rewritten=run('java',['-cp',temporary,'NonrepeatingLoops','next']);
    assert.equal(rewritten,original);
    const expected=[];
    for(let v=0;v<8;v++)for(let choose=0;choose<2;choose++)for(let mode=0;mode<16;mode++)for(let lock=0;lock<2;lock++) {
      let trace='',result,total=0;
      const done=value=>value+':'+trace;
      const errors={1:'S',2:'R',3:'E',4:'N'};
      const actionErrors={5:'S',6:'R',7:'E'};
      for(let round=0;round<(v===7?2:1);round++) {
        if(v===7)trace+='Q';trace+='G';
        if(errors[mode]){result='error:'+errors[mode];break;}
        if(!choose){trace+='T';if(v===7){total+=31;continue;}result=done(31);break;}
        if(v===1&&mode===11){trace+='T';result=done(31);break;}
        let pending;
        if((v===4||v===6)&&lock===0)pending='error:N';
        else {
          if(v===4||v===6)trace+='L';trace+='B';
          pending=actionErrors[mode]?'error:'+actionErrors[mode]:done(23);
          if(v===3&&mode===5){trace+='S';pending=done(70);}
          else if(v===3&&mode===6)trace+='R';
          if(v===5&&mode===13){trace+='I';pending=done(24);}
        }
        if(v===2||v===6) {
          trace+='F';const error={8:'S',9:'R',10:'E'}[mode];
          if(error)pending='error:'+error;
          else if(mode===12){if(v===2)pending=done(99);else{trace+='T';pending=done(31);}}
        }
        if(v===7&&!actionErrors[mode]&&(mode===14||mode===15)){
          if(mode===15){trace+='T';total+=31;}continue;
        }
        result=pending;break;
      }
      result??=done(total);
      expected.push(v+','+choose+','+mode+','+lock+'|'+result+'|'+trace);
    }
    assert.equal(original,expected.join('\n')+'\n');
    assert.equal(expected.length,512);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});
