'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');
const {recoverScalarIfDispatches: recover, foldScalarSwitchPrefixes: foldPrefixes} = require('../src/decompiler/javaAstEmitter');
const {tokenizeJava} = require('../src/java-frontend/lexer');

function ladder(action) {
  return 'if(selected!=0){if(selected!=1){if(selected!=2){if(selected==3){' + action(3) + '}'
    + 'if(selected!=4){if(selected!=5){if(6==selected){' + action(6) + '}'
    + 'if(selected!=7){break Section;}' + action(7) + '}' + action(5) + '}' + action(4) + '}'
    + action(2) + '}' + action(1) + '}' + action(0);
}

test('terminating equality prefixes join an existing captured-int switch without changing its tail', () => {
  const source='int selected=prepare();Tag:{if(selected==-2147483648){first();break Tag;}if(!(selected!=2147483647)){second();return done();}switch(((selected))){case 1:step();break;default:fallback();}}after();';
  const result=foldPrefixes(source,{retainDiagnostics:true});assert.equal(result.switchesExtended,1);assert.equal(result.comparisonsRemoved,2);assert.equal(result.blocksUnwrapped,2);
  assert.match(result.source,/switch\(\(\(selected\)\)\)/);assert.match(result.source,/case -2147483648:/);assert.match(result.source,/case 2147483647:/);
  assert.ok(result.source.includes('case 1:step();break;default:fallback();'));assert.equal(foldPrefixes(result.source).switchesExtended,0);
});

test('prefix declaration blocks remain scoped while empty declaration scopes can be flattened', () => {
  const source='int selected=prepare();Tag:{if(selected==0){int value=selected;use(value);break Tag;}if(selected==1){try{hit();}finally{finish();}break Tag;}switch(selected){case 2:int value=7;use(value);break;default:miss();}}';
  const result=foldPrefixes(source);assert.equal(result.switchesExtended,1);assert.equal(result.blocksUnwrapped,1);
  assert.match(result.source,/case 0: \{int value=selected;use\(value\);break Tag;\}/);assert.match(result.source,/case 2:int value=7;/);
});

test('prefix diagnostics preserve the existing header, every action and the complete old switch body', () => {
  const source='int selected=prepare();Tag:{before();if(selected==0){hit();break Tag;}switch(selected){case 2:tail();break;default:miss();}after();}';
  const result=foldPrefixes(source,{retainDiagnostics:true}),d=result.diagnostics;
  const lexical=s=>tokenizeJava(s).tokens.filter(t=>!['whitespace','eof'].includes(t.kind)).map(t=>t.text);
  const copy=range=>lexical(source.slice(range.start,range.end));
  const expected=[...lexical(source.slice(0,d.regionRange.start)),...copy(d.headerRange),...d.actions.flatMap(action=>[...lexical('case '+action.cases[0]+':'),...copy(action.range)]),...copy(d.tailRange),...lexical(source.slice(d.regionRange.end))];
  assert.deepEqual(lexical(result.source),expected);assert.equal(source.slice(d.selectorOrigin,d.selectorOrigin+d.selector.length),d.selector);
});

test('overlapping, effectful, mutable, boxed, incomplete or retargeted switch prefixes refuse', () => {
  const good='int selected=prepare();Tag:{if(selected==0){hit();break Tag;}switch(selected){case 2:tail();break;default:miss();}}';
  for(const source of [good.replace('case 2:','case 0:'),good.replace('case 2:','case 0x2:'),good.replace('case 2:',"case 'A':"),
    good.replace('break Tag;','finish();'),good.replace('hit();','selected++;hit();'),good.replace('hit();','selected+=1;hit();'),
    good.replace('hit();','try{hit();}finally{selected=2;}'),good.replace('int selected=','Integer selected='),
    good.replace('selected==0','read()==0'),good.replace('selected==0','selected!=0'),good.replace('break Tag;','break;'),
    good.replace('hit();','{int selected=0;hit();}'),good.replace('switch(selected)','switch(read())'),
    good.replace('break Tag;','break Missing;'),good+' // comment\n',good+'\\u000a',good+'Runnable r=()->hit();'])assert.equal(foldPrefixes(source).source,source);
  assert.equal(foldPrefixes(good,{retainDiagnostics:'yes'}).source,good);
});

test('switch-prefix region, case-count and source budgets retain the complete original', () => {
  const body=n=>Array.from({length:n},(_,i)=>`if(selected==${i}){hit();break Tag;}`).join('');
  const many='int selected=prepare();Tag:{'+body(33)+'switch(selected){default:miss();}}';assert.equal(foldPrefixes(many).source,many);
  const cases='int selected=prepare();Tag:{if(selected==-1){hit();break Tag;}switch(selected){'+Array.from({length:65},(_,i)=>`case ${i}:hit();break;`).join('')+'}}';assert.equal(foldPrefixes(cases).source,cases);
  const large='int selected=prepare();Tag:{if(selected==0){hit();break Tag;}switch(selected){default:hit("'+'x'.repeat(40001)+'");}}';assert.equal(foldPrefixes(large).source,large);
  const huge='int selected=prepare();Tag:{if(selected==0){hit();break Tag;}switch(selected){default:miss();}}'+' '.repeat(400001);assert.equal(foldPrefixes(huge).source,huge);
});

test('native switch prefixes match independent selector, action and protected completion models', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'switch-prefix-native-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  let methods='';
  for(let v=0;v<6;v++){
    const action=stage=>{
      let body=`emit(${stage},mode);if(mode==6)continue Outer;if(mode==7)return done();if(flag!=0&&escape(${stage},mode))return done();break Tag;`;
      if(v===2||v===5)body=`synchronized(lock){emit(-7,mode);${body}}`;
      if(v===3)body=`try{${body}}catch(Specific failure){emit(-8,mode);break Tag;}`;
      if(v===1||v===3||v===5)body=`try{${body}}finally{emit(${stage}+20,mode);if(mode==10)continue Outer;if(mode==11)return done();if(mode==12)throw FAILURE;}`;
      if(v===4)body=`int copy=selected;emit(copy==selected?-9:-10,mode);${body}`;
      return body;
    };
    const source=`int selected=input;Outer:for(int round=0;round<2;round++){Tag:{if(selected==Integer.MIN_VALUE){${action(1)}}if(!(selected!=0)){${action(2)}}if(selected==Integer.MAX_VALUE){${action(3)}}switch(selected){case 1:emit(4,mode);if(mode==15)selected=0;if(flag!=0)break;case 2:emit(5,mode);break;default:emit(6,mode);}emit(7,mode);}emit(8,mode);}return done();`
      .replace('selected==Integer.MIN_VALUE','selected==-2147483648').replace('selected==Integer.MAX_VALUE','selected==2147483647');
    const next=foldPrefixes(source);assert.equal(next.switchesExtended,1,'variant '+v);assert.equal(next.comparisonsRemoved,3);assert.equal(foldPrefixes(next.source).switchesExtended,0);
    for(const[name,body]of Object.entries({old:source,next:next.source}))methods+=`static String ${name}${v}(int input,int flag,int mode,Object lock){${body}}\n`;
  }
  const fixture=`public class PrefixNative {
    static class Specific extends RuntimeException{}static final Specific FAILURE=new Specific();static int effects;static StringBuilder trace;
    static void emit(int stage,int mode){trace.append(stage).append(',');effects=Integer.rotateLeft(effects^((stage+17)*0x9e3779b9),stage&31);if(stage==mode)throw FAILURE;}
    static Boolean escape(int stage,int mode){trace.append('g').append(stage).append(',');if(mode==8&&stage==2)return null;return mode==9;}
    static String done(){return effects+":"+trace;}
    ${methods}
    // Classification and pending completion are modeled directly, separately
    // from both the parsed prefix and the generated switch.
    static String oracle(int variant,int input,int flag,int mode,Object lock){int selected=input;
      for(int round=0;round<2;round++){int stage=selected==Integer.MIN_VALUE?1:selected==0?2:selected==Integer.MAX_VALUE?3:0;boolean nextRound=false;String pending=null;Throwable failure=null;
        if(stage!=0){
          if(variant==4)emit(-9,mode);
          if((variant==2||variant==5)&&lock==null)failure=new NullPointerException();else{
            if(variant==2||variant==5)emit(-7,mode);
            try{emit(stage,mode);if(mode==6)nextRound=true;else if(mode==7)pending=done();else if(flag!=0&&escape(stage,mode))pending=done();}catch(Throwable caught){failure=caught;}
          }
          if(variant==3&&failure==FAILURE){emit(-8,mode);failure=null;}
          if(variant==1||variant==3||variant==5){emit(stage+20,mode);if(mode==10){nextRound=true;pending=null;failure=null;}else if(mode==11){nextRound=false;failure=null;pending=done();}else if(mode==12){nextRound=false;pending=null;failure=FAILURE;}}
          if(failure!=null){if(failure==FAILURE)throw FAILURE;throw new NullPointerException();}if(pending!=null)return pending;if(nextRound)continue;
        }else{
          if(selected==1){emit(4,mode);if(mode==15)selected=0;if(flag==0)emit(5,mode);}else emit(selected==2?5:6,mode);emit(7,mode);
        }emit(8,mode);
      }return done();
    }
    static String invoke(int kind,int variant,int input,int flag,int mode,Object lock,int seed){effects=seed;trace=new StringBuilder();String result;try{if(kind==2)result=oracle(variant,input,flag,mode,lock);else switch(variant){${Array.from({length:6},(_,i)=>`case ${i}:result=kind==0?old${i}(input,flag,mode,lock):next${i}(input,flag,mode,lock);break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){if(failure==FAILURE)result="injected";else if(failure instanceof NullPointerException)result="null";else throw new AssertionError(failure);}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+"|"+effects+"|"+trace;}
    public static void main(String[]args){int cases=0;Object monitor=new Object();for(int variant=0;variant<6;variant++)for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,2,3,9,Integer.MAX_VALUE})for(int flag:new int[]{-1,0,1})for(int mode=0;mode<16;mode++)for(Object lock:new Object[]{null,monitor})for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE}){String expected=invoke(2,variant,input,flag,mode,lock,seed);for(int kind=0;kind<2;kind++){String actual=invoke(kind,variant,input,flag,mode,lock,seed);if(!actual.equals(expected))throw new AssertionError(variant+":"+input+":"+flag+":"+mode+":"+seed+":"+actual+" != "+expected);}cases++;}System.out.println(cases+" independent switch prefix cases");}
  }`;
  try{const file=path.join(temporary,'PrefixNative.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);assert.equal(run('java',['-XX:-OmitStackTraceInFastThrow','-Xmx128m','-cp',temporary,'PrefixNative']).trim(),'13824 independent switch prefix cases');}
  finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('captured integer ladders become ordered switches with guarded fallthrough and intact prefix', () => {
  const body = ladder(k => 'step(' + k + ');if(flag==0)break Section;');
  const source = 'int selected=0;Section:{selected=prepare();' + body + '}after();';
  const result = recover(source, {retainDiagnostics: true});
  assert.equal(result.dispatchesRecovered, 1);
  assert.match(result.source, /selected=prepare\(\);\s*switch \(selected\)/);
  assert.deepEqual(result.diagnostics.actions.flatMap(action => action.cases), [3,6,7,5,4,2,1,0]);
  assert.equal(result.diagnostics.conditionRanges.length,8);
  assert.equal(result.diagnostics.actions.filter(action => action.default).length,1);
  assert.equal(result.diagnostics.actions.filter(action => action.exitAdded).length,2);
  assert.equal(result.source.match(/if\(flag==0\)break Section;/g).length,8);
  assert.equal(result.source.match(/step\(/g).length,8);
  assert.equal(recover(result.source).dispatchesRecovered,0);
});

test('empty paths and grouped integer cases retain their own exits', () => {
  for (const body of [
    'if(selected!=0){if(selected!=1){if(selected!=2){break Section;}step(2);}step(1);}step(0);',
    'if(selected==0){step(0);break Section;}if(selected==1){step(1);break Section;}if(selected==2){step(2);break Section;}',
    'if(!(selected!=-2147483648)){step(0);break Section;}if(selected==2147483647){step(1);break Section;}if(selected==2){step(2);break Section;}',
  ]) {
    const source = 'int selected=prepare();Section:{' + body + '}after();';
    assert.equal(recover(source).dispatchesRecovered,1,source);
  }
});

test('mutable classifiers, shared noncontiguous work, altered break scopes and ambiguity refuse', () => {
  const action = k => 'step(' + k + ');if(flag==0)break Section;';
  const good = 'int selected=prepare();Section:{' + ladder(action) + '}after();';
  const bodies = [
    good.replace('step(3);','selected++;step(3);'),
    good.replace('step(3);','selected+=1;step(3);'),
    good.replace('step(3);','try{step(3);}finally{selected=0;}'),
    good.replace('int selected=', 'Integer selected='),
    good.replace('int selected=prepare();',''),
    good.replace('step(3);','{int selected=1;step(selected);}'),
    good.replace('step(3);','while(more()){if(stop)break;step(3);}'),
    good.replace('step(3);','switch(other){default:step(3);}'),
    'int selected=prepare();while(more()){Section:{if(selected==0){break;}if(selected==1){step(1);}if(selected==2){step(2);}}}',
    'int selected=prepare();Section:{if(selected==0){a();}else{b();}if(selected==1){c();}if(selected==2){d();}shared();}',
    good.replace('step(3);','try{step(3);}catch(RuntimeException selected){recover();}'),
    good.replace('break Section;','break Missing;'),
    good+'Section:{}', good+' // comment\n', good+'\\u000a', good+'Runnable r=()->step();',
    good.replace('step(3);','1+2;'), good.replace('step(3);','step(3)'),
    good.replace('step(3);','return;step(3);'),
  ];
  for (const source of bodies) assert.equal(recover(source).source,source,source);
  assert.equal(recover(good,{retainDiagnostics:'yes'}).source,good);
});

test('oversized classifier and depth budgets refuse without dropping earlier work', () => {
  const many = Array.from({length:17},(_,i) => `if(selected==${i}){step(${i});break Section;}`).join('');
  const source='int selected=prepare();Section:{'+many+'}after();';
  assert.equal(recover(source).source,source);
  const deep='int selected=prepare();Section:{'+ '{'.repeat(34)+ladder(k=>'step('+k+');if(flag==0)break Section;')+'}'.repeat(34)+'}';
  assert.equal(recover(deep).source,deep);
});

test('nested suffix dispatch retains switches, loop exits and selector writes in its opaque prefix', () => {
  const prefix='switch(other){case 0:step(9);break;default:step(8);}for(int i=0;i<2;i++){if(stop)break;step(i);}try{selected=prepare();}finally{mark();}';
  const source='int selected=0;Section:{if(enabled){'+prefix+ladder(k=>'step('+k+');if(flag==0)break Section;')+'}}after();';
  assert.equal(recover(source).source,source,'original whole-frame policy remains conservative');
  const result=recover(source,{nestedRegions:true,retainDiagnostics:true});
  assert.equal(result.dispatchesRecovered,1);assert.ok(result.source.includes(prefix));
  assert.deepEqual(result.diagnostics.actions.flatMap(action=>action.cases),[3,6,7,5,4,2,1,0]);
  assert.match(result.source,/if\(enabled\)\{/);assert.equal(result.source.match(/break Section;/g).length,9);
  assert.equal(recover(result.source,{nestedRegions:true}).dispatchesRecovered,0);
});

test('nested region uses its own captured local scope and leaves surrounding case exits intact', () => {
  for(const source of [
    'Section:{if(enabled){int selected=prepare();'+ladder(k=>'step('+k+');if(flag==0)break Section;')+'}}',
    'Section:{switch(other){case 0:{int selected=prepare();'+ladder(k=>'step('+k+');if(flag==0)break Section;')+'}break;default:step(9);}}',
    'int selected=0;Outer:for(int round=0;round<2;round++){Section:{try{synchronized(lock){selected=prepare();'+ladder(k=>'step('+k+');if(flag==0)continue Outer;')+'}}finally{finish();}}}',
  ])assert.equal(recover(source,{nestedRegions:true}).dispatchesRecovered,1);
});

test('nested suffix still refuses altered transfer destinations, mutable classifiers and merged scopes', () => {
  const good='int selected=0;Section:{if(enabled){switch(other){default:step(9);}selected=prepare();'+[0,1,2].map(k=>'if(selected=='+k+'){step('+k+');break Section;}').join('')+'}}';
  for(const source of [good.replace('step(0);','selected++;step(0);'),good.replace('step(0);','try{step(0);}finally{selected=2;}'),
    good.replace('int selected=','Integer selected='),good.replace('step(0);','{int selected=0;step(selected);}'),
    good.replace('step(0);','while(more()){step(0);}'),good.replace('step(0);','switch(extra){default:step(0);}'),
    good.replace('step(0);','if(stop)break;step(0);'),good.replace('step(0);','class Nested{}step(0);'),
    good+' // comment\n',good+'\\u000a',good.replace('break Section;','break Missing;')])
    assert.equal(recover(source,{nestedRegions:true}).source,source);
  assert.equal(recover(good,{nestedRegions:1}).source,good);
});

test('native nested suffixes match independent case runs after opaque prefixes and protected completion', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'scalar-nested-dispatch-native-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const body=action=>'if(selected!=0){if(selected!=1){if(selected!=2){if(selected==3){'+action(3)+'}if(selected!=4){break Section;}'+action(4)+'}'+action(2)+'}'+action(1)+'}'+action(0);
  let methods='';
  for(let v=0;v<6;v++){
    const action=k=>{
      let inner=`emit(${k},mode);if(mode==5&&${k}==2)continue Rounds;if(mode==6&&${k}==1)return done();if(mode==9&&${k}==3)break Outer;if(flag==0||escape(${k},mode))break Section;`;
      if(v===3||v===4)inner=`synchronized(mode==13?null:lock){emit(-7,mode);${inner}}`;
      if(v===2)inner=`try{${inner}}catch(Specific failure){emit(-8,mode);break Outer;}`;
      if(v===5)inner=`try{${inner}}catch(Specific failure){emit(-9,mode);throw failure;}`;
      if(v===1||v===4)inner=`try{${inner}}finally{emit(20+${k},mode);if(mode==10)break Section;if(mode==11)continue Rounds;if(mode==12)return done();}`;
      return inner;
    };
    const source=`int selected=0;Rounds:for(int round=0;round<2;round++){Outer:{Section:{synchronized(lock){if(enabled){switch(prefix){case 0:emit(-2,mode);if(flag==0)break;case 1:emit(-1,mode);break;default:emit(-3,mode);}for(int i=0;i<2;i++){emit(-10-i,mode);if(mode==16)break;}try{emit(-4,mode);selected=7;}finally{selected=input+round;emit(-5,mode);if(mode==15)return done();}${body(action)}emit(90,mode);}emit(91,mode);}}emit(92,mode);}emit(93,mode);}return done();`;
    assert.equal(recover(source).dispatchesRecovered,0,'opaque prefix stays outside old policy');
    const next=recover(source,{nestedRegions:true});assert.equal(next.dispatchesRecovered,1,'nested variant '+v);
    assert.equal(recover(next.source,{nestedRegions:true}).dispatchesRecovered,0);
    for(const [name,code]of Object.entries({old:source,next:next.source}))methods+=`static String ${name}${v}(int input,int flag,int mode,int prefix,boolean enabled,Object lock){${code}}\n`;
  }
  const fixture=`public class NestedDispatch {
    static class Specific extends RuntimeException{}static final Specific FAILURE=new Specific();static int effects;static StringBuilder trace;
    static void emit(int stage,int mode){trace.append(stage).append(',');effects=Integer.rotateLeft(effects^((stage+17)*0x9e3779b9),stage&31);if(stage==mode||stage==-4&&mode==14)throw FAILURE;}
    static Boolean escape(int stage,int mode){trace.append('g').append(stage).append(',');if(mode==7&&stage==2)return null;return mode==8&&stage==0;}
    static String done(){return effects+":"+trace;}
    ${methods}
    // The model selects an explicit observed run, then models pending
    // completion independently; it does not parse or rebuild the if ladder.
    static String oracle(int variant,int input,int flag,int mode,int prefix,boolean enabled,Object lock){
      for(int round=0;round<2;round++){boolean leaveOuter=false,nextRound=false,leaveSection=false;
        if(lock==null)throw new NullPointerException();
        if(enabled){
          if(prefix==0){emit(-2,mode);if(flag!=0)emit(-1,mode);}else emit(prefix==1?-1:-3,mode);
          emit(-10,mode);if(mode!=16)emit(-11,mode);
          int selected=0;Throwable prefixFailure=null;try{emit(-4,mode);}catch(Throwable failure){prefixFailure=failure;}selected=input+round;emit(-5,mode);if(mode==15)return done();if(prefixFailure!=null)throw FAILURE;
          int[] run=selected==0?new int[]{0}:selected==1?new int[]{1,0}:selected==2?new int[]{2,1,0}:selected==3?new int[]{3}:selected==4?new int[]{4,2,1,0}:new int[]{};
          for(int stage:run){Throwable failure=null;String pending=null;
            if((variant==3||variant==4)&&mode==13)failure=new NullPointerException();else{
              if(variant==3||variant==4)emit(-7,mode);
              try{emit(stage,mode);if(mode==5&&stage==2)nextRound=true;else if(mode==6&&stage==1)pending=done();else if(mode==9&&stage==3)leaveOuter=true;else if(flag==0||escape(stage,mode))leaveSection=true;}catch(Throwable caught){failure=caught;}
            }
            if(failure==FAILURE&&variant==2){emit(-8,mode);failure=null;leaveOuter=true;}
            if(failure==FAILURE&&variant==5)emit(-9,mode);
            if(variant==1||variant==4){emit(20+stage,mode);if(mode==10){failure=null;pending=null;nextRound=false;leaveOuter=false;leaveSection=true;}else if(mode==11){failure=null;pending=null;leaveOuter=false;leaveSection=false;nextRound=true;}else if(mode==12){failure=null;pending=done();leaveOuter=false;leaveSection=false;nextRound=false;}}
            if(failure!=null){if(failure==FAILURE)throw FAILURE;throw new NullPointerException();}if(pending!=null)return pending;if(leaveOuter||leaveSection||nextRound)break;
          }
          // Key 3 exits the original plain frame after its guarded action;
          // unknown keys also exit without entering any case action.
          if(!leaveOuter&&!nextRound&&!leaveSection){if(selected==3||run.length==0)leaveSection=true;else emit(90,mode);}
        }
        if(nextRound)continue;if(!leaveOuter&&!leaveSection)emit(91,mode);if(!leaveOuter)emit(92,mode);emit(93,mode);
      }return done();
    }
    static String invoke(int kind,int variant,int input,int flag,int mode,int prefix,boolean enabled,Object lock,int seed){effects=seed;trace=new StringBuilder();String result;try{if(kind==2)result=oracle(variant,input,flag,mode,prefix,enabled,lock);else switch(variant){${Array.from({length:6},(_,i)=>`case ${i}:result=kind==0?old${i}(input,flag,mode,prefix,enabled,lock):next${i}(input,flag,mode,prefix,enabled,lock);break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){if(failure==FAILURE)result="injected";else if(failure instanceof NullPointerException)result="null";else throw new AssertionError(failure);}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+"|"+effects+"|"+trace;}
    public static void main(String[]args){int cases=0;Object monitor=new Object();for(int variant=0;variant<6;variant++)for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,2,3,4,5,Integer.MAX_VALUE})for(int flag:new int[]{-5,0,7})for(int mode=0;mode<17;mode++)for(int prefix=-1;prefix<=1;prefix++)for(boolean enabled:new boolean[]{false,true})for(Object lock:new Object[]{null,monitor})for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE}){String expected=invoke(2,variant,input,flag,mode,prefix,enabled,lock,seed);for(int kind=0;kind<2;kind++){String actual=invoke(kind,variant,input,flag,mode,prefix,enabled,lock,seed);if(!actual.equals(expected))throw new AssertionError(variant+":"+input+":"+flag+":"+mode+":"+prefix+":"+enabled+":"+seed+":"+actual+" != "+expected);}cases++;}System.out.println(cases+" independent nested dispatch cases");}
  }`;
  try{const file=path.join(temporary,'NestedDispatch.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);assert.equal(run('java',['-XX:-OmitStackTraceInFastThrow','-Xmx128m','-cp',temporary,'NestedDispatch']).trim(),'99144 independent nested dispatch cases');}
  finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('empty defaults and extreme case constants compile and match an independent value oracle', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'scalar-empty-dispatch-native-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  try {
    const source='int selected=input;int value=seed;Section:{if(selected==-2147483648){value+=11;break Section;}if(selected==2147483647){value+=13;break Section;}if(selected==2){value+=17;break Section;}}return value;';
    const result=recover(source);assert.equal(result.dispatchesRecovered,1);
    const file=path.join(temporary,'EmptyDispatch.java');
    fs.writeFileSync(file,`public class EmptyDispatch {static int old(int input,int seed){${source}}static int next(int input,int seed){${result.source}}public static void main(String[]args){for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,2,3,Integer.MAX_VALUE})for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE}){int expected=seed+(input==Integer.MIN_VALUE?11:input==Integer.MAX_VALUE?13:input==2?17:0);if(old(input,seed)!=expected||next(input,seed)!=expected)throw new AssertionError();}System.out.println("21 independent empty/default/extreme-key cases");}}`);
    run('javac',['--release','8','-d',temporary,file]);assert.equal(run('java',['-cp',temporary,'EmptyDispatch']).trim(),'21 independent empty/default/extreme-key cases');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('native switches match an independent case-run model with flags, exceptions, cleanup and monitors', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'scalar-if-dispatch-native-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:16*1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  try {
    let methods='';
    for(let v=0;v<7;v++) {
      const action=k=>{
        const inner=`step(${k},mode,t);state=mix(state,${k});if(mode==18)break Outer;${v===6?'if(mode==16)continue Rounds;if(mode==17)return done(state,t);':''}if(flag==0||escape(${k},mode,t))break Section;`;
        const cleanup=`cleanup(${k},mode,t);if(mode==14)break Section;if(mode==15)return done(99,t);`;
        if(v===1)return `try{${inner}}finally{${cleanup}}`;
        if(v===2)return `synchronized(lock){t.append("L");${inner}}`;
        if(v===3)return `try{${inner}}catch(Specific failure){t.append("C");break Outer;}`;
        if(v===4)return `try{synchronized(lock){t.append("L");${inner}}}finally{${cleanup}}`;
        if(v===5)return `{${inner}}`;
        return inner;
      };
      const source='int selected=0;Rounds:for(int round=0;round<2;round++){Outer:{Section:{selected=prepare(input,mode,t);'+ladder(action)+'}t.append("S");}t.append("O");}return done(state,t);';
      const r=recover(source,{retainDiagnostics:true});assert.equal(r.dispatchesRecovered,1,'variant '+v);
      for(const[name,body]of Object.entries({old:source,next:r.source}))methods+=`static String ${name}${v}(int input,int flag,int mode,Object lock,int state){StringBuilder t=trace=new StringBuilder();${body}}\n`;
    }
    const fixture=`public class ScalarIfDispatches {
      static class Specific extends RuntimeException{}static class General extends RuntimeException{}static final Specific SPECIFIC=new Specific();static final General GENERAL=new General();static final Error FATAL=new Error();static StringBuilder trace;
      static int prepare(int input,int mode,StringBuilder t){t.append("P");if(mode==19)throw GENERAL;return input;}
      static int mix(int value,int k){return Integer.rotateLeft(value^(k+1)*0x9e3779b9,k);}
      static void step(int k,int mode,StringBuilder t){t.append(k);if(mode==k+1)throw SPECIFIC;if(mode==9&&k==5)throw FATAL;}
      static Boolean escape(int k,int mode,StringBuilder t){t.append("g").append(k);if(mode==12&&k==1)return null;if(mode==13&&k==6)throw GENERAL;return mode==11&&k==2;}
      static void cleanup(int k,int mode,StringBuilder t){t.append("f").append(k);if(mode==10)throw SPECIFIC;}
      static String done(int state,StringBuilder t){return state+":"+t;}
      ${methods}
      static String invoke(boolean next,int v,int input,int flag,int mode,Object lock,int state){try{switch(v){${Array.from({length:7},(_,i)=>`case ${i}:return next?next${i}(input,flag,mode,lock,state):old${i}(input,flag,mode,lock,state);`).join('')}}throw new AssertionError();}
        catch(Throwable failure){if(failure==SPECIFIC)return "error:S";if(failure==GENERAL)return "error:G";if(failure==FATAL)return "error:E";if(failure instanceof NullPointerException)return "error:N";throw new AssertionError(failure);}}
      public static void main(String[]args){boolean next=args[0].equals("next");for(int v=0;v<7;v++)for(int input:new int[]{Integer.MIN_VALUE,-1,0,1,2,3,4,5,6,7,8,Integer.MAX_VALUE})for(int flag=-1;flag<=1;flag++)for(int mode=0;mode<20;mode++)for(int lk=0;lk<2;lk++)for(int seed:new int[]{0,Integer.MAX_VALUE}){
        Object lock=lk==0?null:new Object();String result=invoke(next,v,input,flag,mode,lock,seed);if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");System.out.println(v+","+input+","+flag+","+mode+","+lk+","+seed+"|"+result+"|"+trace);}}
    }`;
    const file=path.join(temporary,'ScalarIfDispatches.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);
    const original=run('java',['-cp',temporary,'ScalarIfDispatches','old']);assert.equal(run('java',['-cp',temporary,'ScalarIfDispatches','next']),original);
    // Explicit observed runs, independent of the AST/path classifier.
    const runs={0:[0],1:[1,0],2:[2,1,0],3:[3],4:[4,2,1,0],5:[5,4,2,1,0],6:[6],7:[7,5,4,2,1,0]},expected=[];
    for(let v=0;v<7;v++)for(const input of [-2147483648,-1,0,1,2,3,4,5,6,7,8,2147483647])for(let flag=-1;flag<=1;flag++)for(let mode=0;mode<20;mode++)for(let lock=0;lock<2;lock++)for(const seed of [0,2147483647]) {
      let state=seed,trace='',result;
      for(let round=0;round<2&&result===undefined;round++) {
        trace+='P';if(mode===19){result='error:G';break;}
        let outer=false,nextRound=false;
        for(const k of runs[input]||[]) {
          let failure,pending,section=false;
          if((v===2||v===4)&&!lock)failure='N';
          else {
            if(v===2||v===4)trace+='L';trace+=k;
            if(mode===k+1)failure='S';else if(mode===9&&k===5)failure='E';
            else {const mixed=state^Math.imul(k+1,0x9e3779b9);state=(mixed<<k)|(mixed>>>(32-k));
              if(mode===18)outer=true;else if(v===6&&mode===16)nextRound=true;else if(v===6&&mode===17)pending=state+':'+trace;
              else if(flag===0)section=true;else{trace+='g'+k;if(mode===12&&k===1)failure='N';else if(mode===13&&k===6)failure='G';else if(mode===11&&k===2)section=true;}}
          }
          if(v===3&&failure==='S'){trace+='C';failure=undefined;outer=true;}
          if(v===1||v===4){trace+='f'+k;if(mode===10){failure='S';pending=undefined;section=false;outer=false;nextRound=false;}
            else if(mode===14){failure=undefined;pending=undefined;section=true;outer=false;nextRound=false;}
            else if(mode===15){failure=undefined;pending='99:'+trace;section=false;outer=false;nextRound=false;}}
          if(failure){result='error:'+failure;break;}if(pending!==undefined){result=pending;break;}if(section||outer||nextRound)break;
        }
        if(result!==undefined)break;if(nextRound)continue;if(!outer)trace+='S';trace+='O';
      }
      if(result===undefined)result=state+':'+trace;expected.push(`${v},${input},${flag},${mode},${lock},${seed}|${result}|${trace}`);
    }
    assert.equal(expected.length,20160);assert.equal(original,expected.join('\n')+'\n','all20160 native cases match independent case-run/guard/finally model');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});
