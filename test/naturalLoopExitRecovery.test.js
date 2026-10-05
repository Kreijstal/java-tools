'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {foldNaturalLoopExits:fold}=require('../src/decompiler/javaAstEmitter');
const {tokenizeJava}=require('../src/java-frontend/lexer');
const finish=source=>{let count=0;for(;;){const next=fold(source);if(!next.loopExitsRecovered)return {source,count};source=next.source;assert.ok(++count<256);}};

test('terminal own continues use normal iteration completion for every loop form',()=>{
  for(const [old,next]of[
    ['Outer:while(read()){hit();continue Outer;}','while(read()){hit();}'],
    ['Outer:for(int i=0;test(i);i=step(i)){hit();continue Outer;}','for(int i=0;test(i);i=step(i)){hit();}'],
    ['Outer:do{hit();continue Outer;}while(read());','do{hit();}while(read());'],
    ['Outer:for(int i:values){hit();continue Outer;}','for(int i:values){hit();}'],
    ['while(read()){hit();continue;}','while(read()){hit();}'],
    ['Outer:while(read()){if(other())continue Outer;hit();continue;}','Outer:while(read()){if(other())continue Outer;hit();}'],
    ['Outer:while(read()){if(other())break Outer;hit();continue Outer;}','Outer:while(read()){if(other())break Outer;hit();}'],
    ['while(read()){\n  hit();\n  continue;\n}','while(read()){\n  hit();\n}'],
  ]){assert.equal(fold(old).source,next);assert.equal(fold(next).loopExitsRecovered,0);}
});

test('final inner-loop exits take the same outer update and header without moving scopes',()=>{
  for(const [outer,inner]of[
    ['while(ready())','while(more())'],['for(int i=0;test(i);i=step(i))','for(int j=0;test(j);j=step(j))'],
    ['for(int i:values)','for(int j:others)'],
  ]){const old=`Outer:${outer}{before();${inner}{if(stop())continue Outer;hit();}}`;
    const next=fold(old,{retainDiagnostics:true});assert.equal(next.source,`${outer}{before();${inner}{if(stop())break;hit();}}`);
    assert.equal(next.outerContinuesLocalized,1);assert.equal(next.loopLabelsRemoved,1);assert.equal(next.terminalContinuesRemoved,0);
  }
  const old='Outer:do{before();Inner:do{if(stop())continue Outer;if(again())continue Inner;hit();}while(more());}while(ready());';
  assert.equal(fold(old).source,'do{before();Inner:do{if(stop())break;if(again())continue Inner;hit();}while(more());}while(ready());');
});

test('finally overrides, catch branches and monitors keep their complete bodies',()=>{
  const old='Outer:for(int i=0;test(i);i=step(i)){boolean captured=read();while(true){try{synchronized(lock){if(captured)continue Outer;hit();}}catch(RuntimeException ex){if(retry())continue Outer;throw ex;}finally{if(override())continue Outer;finish();}}}';
  const next=fold(old,{retainDiagnostics:true});assert.equal(next.outerContinuesLocalized,3);assert.equal(next.source,old.replace('Outer:','').replaceAll('continue Outer;','break;'));
  const other='Outer:while(read()){while(true){try{if(exit())continue Outer;}finally{if(repeat())continue;finish();}hit();}}';
  assert.equal(fold(other).source,other.replace('Outer:','').replace('continue Outer;','break;'));
});

test('diagnostics independently permit only removed continues/labels and localized keywords',()=>{
  const old='Outer:while(read()){before();while(true){if(stop())continue Outer;hit();}}';
  const next=fold(old,{retainDiagnostics:true});let replay=old;
  for(const edit of next.diagnostics.edits.slice().reverse())replay=replay.slice(0,edit.start)+edit.text+replay.slice(edit.end);
  assert.equal(replay,next.source);
  const lexical=s=>tokenizeJava(s).tokens.filter(t=>!['whitespace','eof'].includes(t.kind));const edits=next.diagnostics.edits;
  const expected=lexical(old).flatMap(token=>{const edit=edits.find(e=>token.range.startOffset>=e.start&&token.range.endOffset<=e.end);return edit?(edit.text?[edit.text]:[]):[token.text];});
  assert.deepEqual(lexical(next.source).map(t=>t.text),expected);
  assert.equal(next.diagnostics.transfers[0].removed,false);assert.equal(old.slice(next.diagnostics.transfers[0].range.start,next.diagnostics.transfers[0].range.end),'continue Outer;');
});

test('suffix effects, intervening scopes, captured breaks and unsupported inputs refuse',()=>{
  for(const source of[
    'Outer:while(read()){while(true){if(stop())continue Outer;hit();}after();}',
    'Outer:while(read()){try{while(true){if(stop())continue Outer;hit();}}finally{finish();}}',
    'Outer:while(read()){synchronized(lock){while(true){if(stop())continue Outer;hit();}}}',
    'Outer:while(read()){while(true){switch(key){case 1:continue Outer;default:hit();}}}',
    'Outer:while(read()){while(true){for(int i=0;i<2;i++){if(stop())continue Outer;}hit();}}',
    'Outer:while(read()){if(stop())continue Outer;while(true){if(exit())continue Outer;hit();}}',
    'Outer:while(read()){while(true){if(stop())break Outer;if(exit())continue Outer;hit();}}',
    'Outer:while(read())if(stop())continue Outer;',
  ])assert.equal(fold(source).source,source,source);
  const good='Outer:while(read()){while(true){if(stop())continue Outer;hit();}}';
  for(const source of[good+' // comment\n',good+'\\u000a',good+'Runnable r=()->hit();',good+'Object holder=new Object(){};',good+'class Nested{}',good+' '.repeat(400001),good+'if('])assert.equal(fold(source).source,source);
  assert.equal(fold(good,{retainDiagnostics:1}).source,good);
  const many='Outer:while(read()){while(true){'+Array(129).fill('if(stop())continue Outer;').join('')+'hit();}}';assert.equal(fold(many).source,many);
  const long='Outer:while(read()){text("'+'x'.repeat(45000)+'");while(true){if(stop())continue Outer;hit();}}';assert.equal(fold(long).source,long);
  const deep='Outer:while(read()){while(true){'+'{'.repeat(140)+'if(stop())continue Outer;'+'}'.repeat(140)+'hit();}}';assert.equal(fold(deep).source,deep);
});

test('native exits match an independent completion dispatcher across loop forms and protected overrides',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'natural-loop-exit-native-'));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
  const core=nested=>`synchronized(lock){try{event(2);if(mode==1||${nested?'flags!=0&&inner>=2':'flags<0'})continue Outer;event(3);if(mode==2)return snapshot(6);if(mode==3)throw FAILURE;}catch(IllegalStateException ex){event(4);if(ex!=FAILURE)throw ex;}finally{event(5);if(mode==4)return snapshot(7);if(mode==5)throw OTHER;if(mode==6)continue Outer;}}`;
  const inners=[body=>`inner=0;while(header(10,inner,3)){${body}event(8);inner=advance(9,inner);}`,
    body=>`for(inner=0;header(10,inner,3);inner=advance(9,inner)){${body}event(8);}`,
    body=>`inner=0;do{${body}event(8);inner=advance(9,inner);}while(header(10,inner,3));`,
    body=>`int[] innerItems=items(3,10);for(int unit:innerItems){inner=unit;event(9);${body}event(8);}`];
  const outers=[body=>`outer=0;Outer:while(header(0,outer,limit)){outer=advance(1,outer);event(11);${body}}`,
    body=>`Outer:for(outer=0;header(0,outer,limit);outer=advance(1,outer)){event(11);${body}}`,
    body=>`outer=0;Outer:do{outer=advance(1,outer);event(11);${body}}while(header(0,outer,limit));`,
    body=>`int[] outerItems=items(limit,0);Outer:for(int element:outerItems){outer=element;event(1);event(11);${body}}`];
  try{
    let methods='';for(let kind=0;kind<8;kind++){
      const nested=kind>=4,body=nested?inners[(kind-4+1)%4](core(true)):core(false)+'event(8);continue Outer;';
      const old=outers[kind%4](body)+'return snapshot(12);',next=finish(old);assert.ok(next.count>0);assert.equal(finish(next.source).count,0);
      methods+=`static String old${kind}(int limit,Object lock){${old}}\nstatic String next${kind}(int limit,Object lock){${next.source}}\n`;
    }
    const fixture=`public class NaturalExitNative {
static final RuntimeException FAILURE=new IllegalStateException("injected"),OTHER=new IllegalStateException("finally");
static int flags,inject,mode,effects,outer,inner;static StringBuilder trace;
static void event(int stage){trace.append((char)('a'+stage));effects=effects*31+stage+flags;if(stage==inject)throw FAILURE;}
static boolean header(int stage,int index,int limit){event(stage);return index<limit;}
static int advance(int stage,int index){event(stage);return index+1;}
static int[] items(int count,int stage){event(stage);int[] result=new int[count];for(int i=0;i<count;i++)result[i]=i;return result;}
static String snapshot(int stage){event(stage);return outer+":"+inner+":"+effects;}
${methods}
static class Pending{final int kind;final String value;Pending(int kind,String value){this.kind=kind;this.value=value;}}
// A round returns an explicit pending completion instead of transferring to a
// caller loop. Its finally can replace that completion or raise an exception.
static Pending round(boolean nested,Object lock){synchronized(lock){try{event(2);if(mode==1||(nested?flags!=0&&inner>=2:flags<0))return new Pending(1,null);event(3);if(mode==2)return new Pending(2,snapshot(6));if(mode==3)throw FAILURE;}catch(IllegalStateException ex){event(4);if(ex!=FAILURE)throw ex;}finally{event(5);if(mode==4)return new Pending(2,snapshot(7));if(mode==5)throw OTHER;if(mode==6)return new Pending(1,null);}}return new Pending(0,null);}
static Pending dispatchInner(int form,Object lock){inner=0;int[] entries=form==3?items(3,10):null;int cursor=0;boolean first=true;for(;;){if(form==3){if(cursor>=entries.length)return new Pending(0,null);inner=entries[cursor++];event(9);}else if(form!=2||!first){if(!header(10,inner,3))return new Pending(0,null);}first=false;Pending next=round(true,lock);if(next.kind!=0)return next;event(8);if(form!=3)inner=advance(9,inner);}}
static String oracle(int kind,int limit,Object lock){int form=kind%4;boolean nested=kind>=4,first=true;outer=0;int[] entries=form==3?items(limit,0):null;int cursor=0;for(;;){if(form==3){if(cursor>=entries.length)break;outer=entries[cursor++];event(1);}else{if(form!=2||!first){if(!header(0,outer,limit))break;}if(form!=1)outer=advance(1,outer);}first=false;event(11);Pending next=nested?dispatchInner((kind-4+1)%4,lock):round(false,lock);if(next.kind==2)return next.value;if(!nested&&next.kind==0)event(8);if(form==1)outer=advance(1,outer);}return snapshot(12);}
static String take(int kind,int variant,int limit,int flag,int failStage,int completionMode,int seed,Object lock){flags=flag;inject=failStage;mode=completionMode;effects=seed;outer=0;inner=0;trace=new StringBuilder();String outcome;try{switch(kind){${Array.from({length:8},(_,i)=>`case ${i}:outcome=variant==0?old${i}(limit,lock):variant==1?next${i}(limit,lock):oracle(${i},limit,lock);break;`).join('')}default:throw new AssertionError();}}catch(Throwable ex){outcome=ex==FAILURE?"failure":ex==OTHER?"override-failure":ex.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return outcome+":"+outer+":"+inner+":"+effects+":"+trace;}
public static void main(String[] args){int cases=0;for(int kind=0;kind<8;kind++)for(int limit=0;limit<4;limit++)for(int flag:new int[]{-1,0,1})for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE})for(int failStage:new int[]{-1,0,2,5,8})for(int completionMode=0;completionMode<7;completionMode++)for(Object lock:new Object[]{null,new Object()}){String want=take(kind,2,limit,flag,failStage,completionMode,seed,lock);for(int variant=0;variant<2;variant++){String got=take(kind,variant,limit,flag,failStage,completionMode,seed,lock);if(!want.equals(got))throw new AssertionError(kind+":"+limit+":"+flag+":"+seed+":"+failStage+":"+completionMode+":"+variant+"\\n"+want+"\\n"+got);}cases++;}System.out.println(cases+" independent cases / 8 loop models");}}
`;
    const file=path.join(temporary,'NaturalExitNative.java');fs.writeFileSync(file,fixture);run('javac',['--release','8','-d',temporary,file]);assert.equal(run('java',['-XX:-OmitStackTraceInFastThrow','-Xmx128m','-cp',temporary,'NaturalExitNative']).trim(),'20160 independent cases / 8 loop models');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
