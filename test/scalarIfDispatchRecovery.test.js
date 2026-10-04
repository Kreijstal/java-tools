'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');
const {recoverScalarIfDispatches: recover} = require('../src/decompiler/javaAstEmitter');

function ladder(action) {
  return 'if(selected!=0){if(selected!=1){if(selected!=2){if(selected==3){' + action(3) + '}'
    + 'if(selected!=4){if(selected!=5){if(6==selected){' + action(6) + '}'
    + 'if(selected!=7){break Section;}' + action(7) + '}' + action(5) + '}' + action(4) + '}'
    + action(2) + '}' + action(1) + '}' + action(0);
}

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
