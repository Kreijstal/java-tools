'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {removeCaughtExceptionCopies} = require('../src/decompiler/javaAstEmitter');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');
const declarations = ['Throwable carrier = null;', 'Throwable failure = null;', 'Object value = null;'];
const rewrite = (source, decl = declarations, names = ['carrier']) => removeCaughtExceptionCopies(source, decl, names);

test('caught carrier copies disappear while destination locals retain their static types', () => {
  const source='try { work(); } catch (IllegalArgumentException caught) { carrier = caught; value = carrier; use(value); } catch (RuntimeException other) { carrier = other; failure = carrier; throw failure; }';
  const result=rewrite(source);
  assert.deepEqual(result.removed,['carrier']);
  assert.deepEqual(result.declarations,declarations.slice(1));
  assert.equal(result.source,'try { work(); } catch (IllegalArgumentException caught) {  value = caught; use(value); } catch (RuntimeException other) {  failure = other; throw failure; }');
  assert.deepEqual(rewrite(source,declarations,[]).removed,[]);
});

test('typed catch-local declarations retain their written types and initializers', () => {
  const source='try { work(); } catch(RuntimeException caught) { carrier=caught; Object local=carrier; overload(local); }';
  const result=rewrite(source);
  assert.deepEqual(result.removed,['carrier']);
  assert.equal(result.source,'try { work(); } catch(RuntimeException caught) {  Object local=caught; overload(local); }');
  for(const type of ['int','var']) {
    const unsupported=source.replace('Object local',type+' local');
    assert.equal(rewrite(unsupported).source,unsupported);
  }
});

test('catch copy recovery refuses escaping reads, changed bindings, conversions and nested handlers', () => {
  const bodies=[
    'carrier = caught; use(carrier);',
    'carrier = caught; throw carrier;',
    'carrier = caught; value = (Object)carrier;',
    'carrier = caught; field.value = carrier;',
    'carrier = caught; values[0] = carrier;',
    'carrier = caught; value = carrier; caught = replacement; value = carrier;',
    'if(flag) { carrier = caught; } value = carrier;',
    'carrier = caught; carrier = replacement; value = carrier;',
    'carrier = caught; { Object value = null; value = carrier; }',
    'carrier = caught; Runnable action = () -> use(carrier);',
    'carrier = caught; try { work(); } catch(RuntimeException nested) { carrier = nested; value = carrier; } value = carrier;',
  ];
  for (const body of bodies) {
    const source='try { work(); } catch(RuntimeException caught) { '+body+' }';
    assert.equal(rewrite(source).source,source,body);
  }
  for(const suffix of ['finally { value = carrier; }','use(carrier);']) {
    const source='try { work(); } catch(RuntimeException caught) { carrier = caught; value = carrier; } '+suffix;
    assert.equal(rewrite(source).source,source);
  }
  const source='try { work(); } catch(RuntimeException caught) { carrier = caught; value = carrier; }';
  for(const decl of [declarations.slice(1),[...declarations,declarations[0]],
    ['Throwable carrier;',...declarations.slice(1)],['Throwable carrier = make();',...declarations.slice(1)],
    ['Throwable carrier = null;', 'int value = 0;'],[...declarations,'Object caught = null;']])
    assert.equal(rewrite(source,decl).source,source,decl.join('\n'));
  assert.equal(rewrite(source+' /* \\u0061 */').source,source+' /* \\u0061 */');
  assert.equal(rewrite(source+' unknown @ syntax;').source,source+' unknown @ syntax;');
});

test('native catch-copy recovery preserves overloads, identity, finally and monitor behavior', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'caught-copy-native-'));
  try {
    const body=`try { work(mode); trace+="n"; }
      catch(IllegalArgumentException caught) { carrier=caught; Object localValue=carrier; trace+=overload(localValue); synchronized(lock) { trace+=Thread.holdsLock(lock); work(handlerMode); } }
      catch(RuntimeException other) { carrier=other; failure=carrier; trace+=overload(failure); work(handlerMode); }
      finally { trace+="f"; work(finalMode); }`;
    const result=rewrite(body);assert.deepEqual(result.removed,['carrier']);
    const source=`public class CaughtCopies {
      static final RuntimeException specific=new IllegalArgumentException(),general=new IllegalStateException();static final Error fatal=new AssertionError();
      static Object lock;static String trace;static void work(int mode){trace+="w";if(mode==1)throw specific;if(mode==2)throw general;if(mode==3)throw fatal;}
      static String overload(Object value){return "O";}static String overload(Throwable value){return "T";}static String overload(RuntimeException value){return "R";}static String overload(IllegalArgumentException value){return "I";}
      static void original(int mode,int handlerMode,int finalMode){${declarations.join('\n')} ${body}}
      static void rebuilt(int mode,int handlerMode,int finalMode){${result.declarations.join('\n')} ${result.source}}
      static String invoke(boolean rebuilt,int mode,int handlerMode,int finalMode,boolean nullLock){trace="";lock=nullLock?null:new Object();String escaped="ok";try{if(rebuilt)rebuilt(mode,handlerMode,finalMode);else original(mode,handlerMode,finalMode);}catch(Throwable error){escaped=error==specific?"specific":error==general?"general":error==fatal?"fatal":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("lock escaped");return trace+":"+escaped;}
      public static void main(String[] args){int cases=0;for(int mode=0;mode<4;mode++)for(int handlerMode=0;handlerMode<4;handlerMode++)for(int finalMode=0;finalMode<4;finalMode++)for(boolean nullLock:new boolean[]{false,true}){String expected=invoke(false,mode,handlerMode,finalMode,nullLock),actual=invoke(true,mode,handlerMode,finalMode,nullLock);if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);if(mode==1&&!actual.contains("O"))throw new AssertionError("Object overload lost");if(mode==2&&!actual.contains("T"))throw new AssertionError("Throwable overload lost");System.out.println(actual);cases++;}if(cases!=128)throw new AssertionError("cases");}
    }`;
    const file=path.join(temporary,'CaughtCopies.java');fs.writeFileSync(file,source);
    execFileSync('javac',['--release','8','-d',temporary,file]);
    assert.equal(execFileSync('java',['-Xverify:all','-cp',temporary,'CaughtCopies'],{encoding:'utf8'}).trim().split('\n').length,128);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('ordinary default decompilation emits direct catch-to-local copies', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'caught-copy-default-'));
  try {
    const native=path.join(temporary,'native'),rebuilt=path.join(temporary,'rebuilt');fs.mkdirSync(native);fs.mkdirSync(rebuilt);
    const source=`public class CatchRoundtrip {public static String run(int mode){try{if(mode==1)throw new IllegalArgumentException("specific");if(mode==2)throw new IllegalStateException("general");if(mode==3)throw new AssertionError("fatal");return "ok";}catch(RuntimeException failure){return failure.getClass().getName()+":"+failure.getMessage();}}}`;
    fs.writeFileSync(path.join(native,'CatchRoundtrip.java'),source);execFileSync('javac',['--release','8','-d',native,path.join(native,'CatchRoundtrip.java')]);
    const java=decompileClassFile(path.join(native,'CatchRoundtrip.class'));assertNoFallback(java);assert.doesNotMatch(java,/decompiledCaughtException/);
    fs.writeFileSync(path.join(rebuilt,'CatchRoundtrip.java'),java);
    const driver='class CatchRunner {public static void main(String[] args){for(int mode=0;mode<4;mode++){try{System.out.println(CatchRoundtrip.run(mode));}catch(Error fatal){System.out.println(fatal.getClass().getName()+":"+fatal.getMessage());}}}}';
    for(const dir of [native,rebuilt]){fs.writeFileSync(path.join(dir,'CatchRunner.java'),driver);execFileSync('javac',['--release','8','-d',dir,path.join(dir,'CatchRoundtrip.java'),path.join(dir,'CatchRunner.java')]);}
    const expected=execFileSync('java',['-Xverify:all','-cp',native,'CatchRunner'],{encoding:'utf8'});
    assert.equal(execFileSync('java',['-Xverify:all','-cp',rebuilt,'CatchRunner'],{encoding:'utf8'}),expected);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});
