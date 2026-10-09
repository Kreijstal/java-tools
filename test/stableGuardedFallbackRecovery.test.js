'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {foldStableGuardedFallbacks: fold} = require('../src/decompiler/javaAstEmitter');
const {tokenizeJava} = require('../src/java-frontend/lexer');
const {shareExistingExitTails: finish} = require('../src/decompiler/cfr')._internals;
const parameters = [{name: 'flag', type: 'int'}, {name: 'enabled', type: 'boolean'}, {name: 'metric', type: 'float'}];
const frame = (prefix = 'hit();', condition = 'enabled', guard = 'flag==0') => `Frame:{if(${condition}){${prefix}if(${guard})break Frame;}fallback();}`;

test('the normal emitter finishes stable guarded fallbacks with actual parameter types', () => {
  const body = frame().split('\n'); finish(body, parameters.map(p => p.name), parameters);
  assert.equal(body.join('\n'), 'if(enabled){hit();} if (!enabled || flag!=0) {fallback();}');
});

test('stable primitive predicates express effectful prefixes and fallbacks once', () => {
  for (const [condition, negative] of [['enabled', '!(enabled)'], ['flag==0', 'flag!=0'], ['flag!=0', 'flag==0'], ['metric>0', '!(metric>0)'], ['enabled&&flag!=0', '!(enabled&&flag!=0)']]) {
    const source = frame('hit();', condition), next = fold(source, {parameters});
    assert.equal(next.framesRecovered, 1); assert.equal(next.conditionCopiesAdded, 1);
    assert.equal(next.source, `if(${condition}){hit();} if (${negative} || flag!=0) {fallback();}`);
    assert.equal(next.source.split('hit();').length - 1, 1); assert.equal(next.source.split('fallback();').length - 1, 1);
    assert.equal(fold(next.source, {parameters}).framesRecovered, 0);
  }
  const source = frame('hit();', 'flag!=0&&flag!=1&&flag!=2');
  assert.equal(fold(source, {parameters}).primitiveReadCopiesAdded, 3, 'count every occurrence, not only distinct names');
});

test('empty prefixes retain one effectful/nullable condition and guard evaluation', () => {
  for (const condition of ['probe()', 'boxed', 'receiver.field', '(flag=probe())!=0']) {
    const source = frame('', condition, 'guard(boxed)'), next = fold(source, {parameters});
    assert.equal(next.framesRecovered, 1); assert.equal(next.conditionCopiesAdded, 0); assert.equal(next.primitiveReadCopiesAdded, 0);
    const identifiers = text => tokenizeJava(text).tokens.filter(t => t.kind === 'identifier').map(t => t.text);
    for (const name of ['probe', 'boxed', 'receiver', 'flag'])
      assert.equal(identifiers(next.source).filter(t => t === name).length, identifiers(source).filter(t => t === name).length);
    assert.equal(next.source.split('guard(boxed)').length - 1, 1);
  }
});

test('declaration scopes, statement positions and complete protected constructs remain', () => {
  for (const source of [
    'int flag=read();boolean enabled=read();Frame:{int n=0;if(enabled){hit();if(flag==0)break Frame;}use(n);}',
    'int flag=read();boolean enabled=read();if(outer())' + frame(),
    'int flag=read();boolean enabled=read();try{synchronized(lock){' + frame('try{hit();}finally{cleanup();}') + '}}finally{finish();}',
    'int flag=read();boolean enabled=read();Outer:while(run()){' + frame('if(stop())continue Outer;hit();') + 'tail();}',
  ]) {
    const next = fold(source, {retainDiagnostics: true}); assert.equal(next.framesRecovered, 1);
    if (source.includes('int n=0') || source.includes('if(outer())')) assert.equal(next.diagnostics.frameScopeRetained, true);
    assert.equal(fold(next.source).framesRecovered, 0);
  }
  const loop = 'boolean enabled=true;int flag=0;Loop:while(run())Frame:{if(enabled){hit();if(flag==0)break Frame;}if(stop())continue Loop;}';
  const next = fold(loop, {retainDiagnostics: true}); assert.equal(next.framesRecovered, 1);
  assert.equal(next.diagnostics.frameScopeRetained, true);
  assert.ok(next.diagnostics.segments.some(segment => segment.range?.start === next.diagnostics.range.end - 1
    && segment.range.end === next.diagnostics.range.end), 'the enclosing loop endpoint retains its original closing token');
});

test('writes in any prefix position and guard-local scope dependencies refuse', () => {
  for (const prefix of ['flag=0;', 'flag+=1;', '++flag;', '(flag)++;', '(flag)=1;', 'call(flag=0);',
    'if(other())flag=0;', 'try{hit();}finally{flag=0;}', 'for(flag=0;more();flag++)hit();', 'assert enabled:flag=0;']) {
    const source = frame(prefix, 'flag!=0'); assert.equal(fold(source, {parameters}).source, source, prefix);
  }
  for (const source of [frame('int local=read();', 'enabled', 'local==0'), frame('Object local=read();', 'enabled', 'local.ready'),
    'boolean enabled=false;' + frame('hit();') + '{boolean enabled=false;}',
    'Boolean enabled=null;' + frame(), '{boolean enabled=false;}' + frame(),
    frame('hit();', 'boxed'), frame('hit();', 'this.enabled'), frame('hit();', 'flag/denominator!=0'), frame('hit();', 'flag++!=0'),
    frame('hit();', 'probe()'), frame('hit();').replace('hit();', 'if(other())break Frame;hit();'),
    frame('hit();').replace('if(flag==0)break Frame;', 'try{if(flag==0)break Frame;}finally{finish();}'),
    frame('hit();').replace('if(flag==0)break Frame;', 'if(flag==0)break Frame;else hit();'),
  ]) assert.equal(fold(source, {parameters}).source, source, source);
});

test('diagnostic fragments reproduce exact bytes and constrain all original and copied tokens', () => {
  const source = 'int flag=read();boolean enabled=read();Frame:{if(enabled&&flag!=0){hit();if((flag=guard())==0){break Frame;}}fallback();}';
  const next = fold(source, {retainDiagnostics: true}), d = next.diagnostics;
  assert.equal(next.framesRecovered, 1); assert.equal(source.slice(d.jumpRange.start, d.jumpRange.end), 'break Frame;');
  const lexical = s => tokenizeJava(s).tokens.filter(t => !['whitespace', 'eof'].includes(t.kind));
  const original = lexical(source), expected = [];
  for (const segment of d.segments) {
    if (segment.text !== undefined) {expected.push(...lexical(segment.text).map(t => t.text)); continue;}
    const copy = original.filter(t => t.range.startOffset >= segment.range.start && t.range.endOffset <= segment.range.end);
    expected.push(...copy.map(t => segment.replacements?.find(r => r.range.start === t.range.startOffset)?.text || t.text));
    if (segment.copy) assert.ok(segment.range.start >= d.conditionRange.start && segment.range.end <= d.conditionRange.end);
  }
  assert.deepEqual(lexical(next.source.slice(d.range.start)).map(t => t.text), expected);
});

test('syntax, nested execution, translated positions and resource limits refuse', () => {
  const good = 'boolean enabled=true;int flag=0;' + frame();
  for (const source of [good + ' //comment\n', good + '\\u000a', good + 'class Nested{}', good + 'Object nested=new Object(){};',
    good + 'Runnable r=()->hit();', good + 'if(', good + ' '.repeat(400001), good.replace('hit();', 'flag+1;'),
    'boolean enabled=true;int flag=0;' + Array.from({length: 257}, (_, i) => frame().replaceAll('Frame', 'Frame' + i)).join(''),
    'boolean enabled=true;int flag=0;' + frame('hit("' + 'x'.repeat(41000) + '");')]) assert.equal(fold(source).source, source);
  assert.equal(fold(good, {retainDiagnostics: 1}).source, good);
  assert.equal(fold(good, {fpStrict: 1}).source, good);
});

test('floating arithmetic is repeated only in a proven FP-strict source context', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-stable-fallback-'));
  const run = (command, args) => {const r = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024}); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();};
  const source = frame('hit();', 'metric*metric>0').replace('fallback();', 'tail();');
  assert.equal(fold(source, {parameters}).source, source, 'non-strict arithmetic may use extended exponents');
  const next = fold(source, {parameters, fpStrict: true}); assert.equal(next.framesRecovered, 1);
  const body = source.split('\n'); finish(body, parameters.map(p => p.name), parameters, null, true);
  assert.equal(body.join('\n'), next.source, 'normal phase uses its actual source strictness');
  try {
    const fixture = `public class StrictStableFallback {
static StringBuilder trace;static void hit(){trace.append('P');}static void tail(){trace.append('F');}
static strictfp String old(float metric,int flag){trace=new StringBuilder();${source}return trace.toString();}
static strictfp String next(float metric,int flag){trace=new StringBuilder();${next.source}return trace.toString();}
public static void main(String[] args){float[] values={Float.NaN,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY,-0.0f,0.0f,Float.MIN_VALUE,-Float.MIN_VALUE,-1.0f,1.0f,Float.MAX_VALUE,-Float.MAX_VALUE};boolean[] choices={false,true,true,false,false,false,false,true,true,true,true};int cases=0;for(int i=0;i<values.length;i++)for(int flag:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE}){String expected=choices[i]?(flag==0?"P":"PF"):"F";if(!expected.equals(old(values[i],flag))||!expected.equals(next(values[i],flag)))throw new AssertionError(i+":"+flag);cases++;}System.out.println(cases+" strict arithmetic cases");}}
`;
    const file = path.join(temporary, 'StrictStableFallback.java'); fs.writeFileSync(file, fixture);
    run('javac', ['--release', '8', '-d', temporary, file]);
    assert.equal(run('java', ['-Xmx128m', '-cp', temporary, 'StrictStableFallback']), '55 strict arithmetic cases');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});

test('native fallbacks match independent action tables and pending-completion models', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-fallback-native-'));
  const run = (command, args) => {const r = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024}); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();};
  const wraps = [s => s, s => `try{${s}}finally{trace.append('F');if(mode==1)return value+":"+flag;if(mode==2)throw OVERRIDE;}`,
    s => `synchronized(lock){trace.append('L');${s}}`, s => `try{${s}}catch(IllegalStateException failure){trace.append('C');if(failure!=FAILURE)throw failure;}finally{trace.append('F');}`,
    s => `try{synchronized(lock){trace.append('L');${s}}}finally{trace.append('F');if(mode==1)return value+":"+flag;if(mode==2)throw OVERRIDE;}`, s => `{${s}}`];
  const signature = 'int seed,int flag,boolean enabled,float metric,Boolean boxed,int inject,int mode,Object lock';
  const args = 'seed,flag,enabled,metric,boxed,inject,mode,lock';
  const condition = '((flag*31)^seed)!=0&&metric>0||enabled';
  const prefix = 'value=value*31+seed;event(1);if(inject==1)throw FAILURE;';
  const fallback = 'value=value+5;event(3);if(inject==3)throw FAILURE;';
  const params = [...parameters, {name: 'seed', type: 'int'}];
  try {
    let methods = '';
    for (let context = 0; context < wraps.length; context++) for (let empty = 0; empty < 2; empty++) {
      const kind = context * 2 + empty;
      const oldBody = `Frame:{if(${empty ? 'condition(boxed,inject)' : condition}){${empty ? '' : prefix}if((flag=guard(boxed,inject))>=0)break Frame;}${fallback}}`;
      const old = 'int value=seed;' + wraps[context](oldBody) + 'return value+":"+flag;', next = fold(old, {parameters: params});
      assert.equal(next.framesRecovered, 1); assert.equal(next.conditionCopiesAdded, empty ? 0 : 1);
      const choose = empty ? 'boolean choice=condition(boxed,inject);' : 'int mixed=((int)((long)flag*31L))^seed;boolean choice=false;if(mixed!=0&&!Float.isNaN(metric)&&metric>0)choice=true;if(enabled)choice=true;';
      const oracleBody = choose + 'boolean keep=false;if(choice){' + (empty ? '' : prefix) + 'int tested=guard(boxed,inject);flag=tested;keep=tested>=0;}boolean[][] dispatch={{true,true},{true,false}};if(dispatch[choice?1:0][keep?1:0]){' + fallback + '}';
      methods += `static String old${kind}(${signature}){${old}}\nstatic String next${kind}(${signature}){${next.source}}\nstatic String oracle${kind}(${signature}){int value=seed;${wraps[context](oracleBody)}return value+":"+flag;}\n`;
    }
    const fixture = `public class StableFallbackNative {
static final RuntimeException FAILURE=new IllegalStateException("injected"),OVERRIDE=new IllegalStateException("finally");static int effects;static StringBuilder trace;
static void event(int stage){trace.append((char)('a'+stage));effects=effects*31+stage;}
static Boolean condition(Boolean boxed,int inject){event(0);if(inject==0)throw FAILURE;return boxed;}
static int guard(Boolean boxed,int inject){event(2);if(inject==2)throw FAILURE;return boxed.booleanValue()?1:-1;}
${methods}
static String take(int kind,int variant,${signature}){effects=seed;trace=new StringBuilder();String result;try{switch(kind){${Array.from({length:12}, (_, i) => `case ${i}:result=variant==0?old${i}(${args}):variant==1?next${i}(${args}):oracle${i}(${args});break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){result=failure==FAILURE?"failure":failure==OVERRIDE?"override":failure.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+effects+":"+trace;}
public static void main(String[] args){int cases=0;for(int kind=0;kind<12;kind++)for(int seed:new int[]{Integer.MIN_VALUE,0,Integer.MAX_VALUE})for(int flag:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(boolean enabled:new boolean[]{false,true})for(float metric:new float[]{Float.NaN,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY,-0.0f,0.0f,-1.0f,1.0f,2.0f})for(Boolean boxed:new Boolean[]{false,true,null})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(Object lock:new Object[]{null,new Object()}){String want=take(kind,2,${args});for(int variant=0;variant<2;variant++){String got=take(kind,variant,${args});if(!want.equals(got))throw new AssertionError(kind+":"+variant+":"+seed+":"+flag+":"+enabled+":"+metric+":"+boxed+":"+inject+":"+mode+"\\n"+want+"\\n"+got);}cases++;}System.out.println(cases+" independent cases / 12 models / 6 contexts");}}
`;
    const file = path.join(temporary, 'StableFallbackNative.java'); fs.writeFileSync(file, fixture);
    run('javac', ['--release', '8', '-d', temporary, file]);
    assert.equal(run('java', ['-XX:-OmitStackTraceInFastThrow', '-Xmx128m', '-cp', temporary, 'StableFallbackNative']), '207360 independent cases / 12 models / 6 contexts');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
