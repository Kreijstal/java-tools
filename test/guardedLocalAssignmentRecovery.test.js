'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {foldGuardedLocalAssignments: fold} = require('../src/decompiler/javaAstEmitter');
const {tokenizeJava} = require('../src/java-frontend/lexer');
const {shareExistingExitTails: finish} = require('../src/decompiler/cfr')._internals;

const choice = (a = '235', b = '285', guard = 'flag==0', condition = 'check()') =>
  `Choice:{if(${condition}){value=${a};if(${guard}){break Choice;}}value=${b};}`;

test('the normal emitter applies value selection with captured primitive parameter types', () => {
  const source = 'int value=0;' + choice(), body = source.split('\n');
  finish(body, ['flag'], [{name: 'flag', type: 'int'}]);
  assert.equal(body.join('\n'), 'int value=0;value = (check()) && (flag==0) ? (235) : (285);');
});

test('guarded primitive-local values become conditional assignments without flag value assumptions', () => {
  for (const [prefix, a, b, cast] of [
    ['int value=0,flag=read();', 'value+seed', 'seed*7-9', ''],
    ['boolean value=false;int flag=read();', 'true', 'false', ''],
    ['long value=0L;int flag=read();', '9007199254740993L', '-9007199254740993L', ''],
    ['float value=0f;int flag=read();', '-0.0f', '0x1.000002p0f', ''],
    ['double value=0d;int flag=read();', '1e300', '-0.0d', ''],
    ['byte value=0;int flag=read();', '127', '-128', '(byte) '],
    ['short value=0;int flag=read();', '-32768', '32767', '(short) '],
    ['char value=0;int flag=read();', '0', '65535', '(char) '],
    ['char value=0;int flag=read();', "'a'", "'z'", ''],
  ]) {
    const source = prefix + choice(a, b), next = fold(source, {parameters: [{name: 'seed', type: 'int'}]});
    assert.equal(next.assignmentsFolded, 1, prefix);
    const expression = `(check()) && (flag==0) ? (${a}) : (${b})`;
    assert.equal(next.source, prefix + 'value = ' + (cast ? cast + '(' + expression + ')' : expression) + ';');
    assert.equal(fold(next.source).assignmentsFolded, 0);
  }
});

test('protected scopes, condition effects and primitive captures remain at their original site', () => {
  const source = `Outer:while(run()){try{synchronized(lock){int value=0;${choice('value+1', '7', 'flag==0', '(flag=read())!=0&&boxed')}use(value);}}finally{finish();}}`;
  const next = fold(source, {parameters: [{name: 'flag', type: 'int'}]});
  assert.equal(next.assignmentsFolded, 1);
  assert.equal(next.source, source.replace(choice('value+1', '7', 'flag==0', '(flag=read())!=0&&boxed'),
    'value = ((flag=read())!=0&&boxed) && (flag==0) ? (value+1) : (7);'));
  assert.equal(fold('int value=0;' + choice('1', '2', 'flag==0'), {parameters: [{name: 'flag', type: 'Integer'}]}).assignmentsFolded, 0);
});

test('diagnostics account for the original guard, values, local writes and consumed transfer', () => {
  const source = 'int value=0,flag=read();' + choice(), next = fold(source, {retainDiagnostics: true});
  const a = next.diagnostics.assignments[0], slice = r => source.slice(r.start, r.end);
  assert.equal(slice(a.guardRange), '(flag==0)'); assert.equal(slice(a.provisionalRange), '235');
  assert.equal(slice(a.fallbackRange), '285'); assert.equal(slice(a.transferRange), 'break Choice;');
  assert.equal(slice(a.declarationRange), 'int value=0,flag=read();'); assert.equal(a.localType, 'int');
  const lexical = s => tokenizeJava(s).tokens.filter(t => !['whitespace', 'eof'].includes(t.kind));
  const old = lexical(source), tokens = r => old.filter(t => t.range.startOffset >= r.start && t.range.endOffset <= r.end).map(t => t.text);
  const expected = [...tokens({start: 0, end: a.range.start}), ...tokens(a.nameRange), '=', ...tokens(a.conditionRange), '&&',
    ...tokens(a.guardRange), '?', '(', ...tokens(a.provisionalRange), ')', ':', '(', ...tokens(a.fallbackRange), ')', ';',
    ...tokens({start: a.range.end, end: source.length})];
  assert.deepEqual(lexical(next.source).map(t => t.text), expected);
});

test('guard dependencies, failing expressions, effects, fields and mixed conditional types refuse', () => {
  for (const [a, b, guard] of [
    ['1', '2', 'value==1'], ['1', 'value+2', 'flag==0'],
    ['call()', '2', 'flag==0'], ['1', 'call()', 'flag==0'], ['1', '2', 'call()'],
    ['1/flag', '2', 'flag==0'], ['1', '2%flag', 'flag==0'], ['1', '2', '1/flag==0'],
    ['array[0]', '2', 'flag==0'], ['this.field', '2', 'flag==0'], ['1', '2', 'this.flag==0'],
    ['flag++', '2', 'flag==0'], ['1', '2', '(flag=0)==0'], ['1', '2', 'boxed==0'],
    ['1', '2L', 'flag==0'], ['1.0f', '2.0d', 'flag==0'], ['1', "'x'", 'flag==0'],
  ]) {
    const source = 'int value=0,flag=read();Integer boxed=0;' + choice(a, b, guard);
    assert.equal(fold(source).source, source, source);
  }
  for (const source of [
    'Integer value=0;int flag=0;' + choice(), 'int[] value=null;int flag=0;' + choice().replaceAll('value=', 'value[0]='),
    'int value=0,flag=0;' + choice().replaceAll('value=', 'this.value='),
    'int flag=0;' + choice(), '{int value=0;}int flag=0;' + choice(),
    'int value=0,flag=0;' + choice().replace('value=235;', 'value=235;hit();'),
    'int value=0,flag=0;' + choice().replace('if(flag==0){', 'try{if(flag==0){').replace('}}value=', '}}finally{finish();}}value='),
    'int value=0,flag=0;' + choice().replace('value=285;', 'if(other())break Choice;value=285;'),
    'int value=0,flag=0;' + choice() + '{int value=0;}',
  ]) assert.equal(fold(source).source, source, source);
});

test('unsupported syntax, translated offsets, nested execution and resource budgets refuse', () => {
  const source = 'int value=0,flag=0;' + choice();
  for (const s of [source + ' // comment\n', source + '\\u000a', source + 'Object obj=new Object(){};',
    source + 'Runnable r=()->hit();', source + 'class Nested{}', source + 'if(', source + ' '.repeat(400001),
    'int value=0,flag=0;' + Array.from({length:257},(_,i)=>choice().replaceAll('Choice','Choice'+i)).join(''),
    source.replace('check()', 'text.equals("' + 'x'.repeat(41000) + '")')]) assert.equal(fold(s).source, s);
  assert.equal(fold(source, {retainDiagnostics: 1}).source, source);
  assert.equal(fold(source, {parameters: [{name: 'flag', type: 'int'}, {name: 'flag', type: 'int'}]}).source, source);
});

test('native selection matches independent tables with effects, overflow and protected completion', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-local-native-'));
  const run = (command, args) => {const r = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024}); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();};
  const wraps = [s => s, s => `try{${s}}finally{trace.append('F');if(mode==1)return value+":"+effects;if(mode==2)throw OVERRIDE;}`,
    s => `synchronized(lock){trace.append('L');${s}}`, s => `try{${s}}catch(IllegalStateException failure){trace.append('C');if(failure!=FAILURE)throw failure;}finally{trace.append('F');}`,
    s => `try{synchronized(lock){trace.append('L');${s}}}finally{trace.append('F');if(mode==1)return value+":"+effects;if(mode==2)throw OVERRIDE;}`,
    s => `{${s}}`];
  const signature = 'int seed,int flag,boolean keep,Boolean boxed,int inject,int mode,Object lock';
  const args = 'seed,flag,keep,boxed,inject,mode,lock';
  const body = choice('value+seed', 'seed*7-9', '((flag*31)^seed)==0||keep', 'probe(boxed,inject)') + "trace.append('A');event(3);if(inject==3)throw FAILURE;";
  const oracle = 'boolean tested=probe(boxed,inject);int preserved=(int)((long)seed+(long)seed);int fallback=(int)((long)seed*7L-9L);boolean retain=(((int)((long)flag*31L))^seed)==0||keep;int[][] table={{fallback,fallback},{fallback,preserved}};value=table[tested?1:0][retain?1:0];' + "trace.append('A');event(3);if(inject==3)throw FAILURE;";
  try {
    let methods = '';
    for (let context = 0; context < wraps.length; context++) {
      const old = 'int value=seed;' + wraps[context](body) + 'return value+":"+effects;', next = fold(old, {parameters: [{name: 'seed', type: 'int'}, {name: 'flag', type: 'int'}, {name: 'keep', type: 'boolean'}]});
      assert.equal(next.assignmentsFolded, 1); assert.equal(fold(next.source).assignmentsFolded, 0);
      methods += `static String old${context}(${signature}){${old}}\nstatic String next${context}(${signature}){${next.source}}\nstatic String oracle${context}(${signature}){int value=seed;${wraps[context](oracle)}return value+":"+effects;}\n`;
    }
    const fixture = `public class GuardedLocalNative {
static final RuntimeException FAILURE=new IllegalStateException("injected"),OVERRIDE=new IllegalStateException("finally");static int effects;static StringBuilder trace;
static void event(int stage){effects=effects*31+stage;trace.append((char)('a'+stage));}
static boolean probe(Boolean boxed,int inject){event(0);if(inject==1)throw FAILURE;boolean result=boxed.booleanValue();event(1);if(inject==2)throw FAILURE;return result;}
${methods}
static String take(int context,int variant,${signature}){effects=seed;trace=new StringBuilder();String result;try{switch(context){${wraps.map((_, i) => `case ${i}:result=variant==0?old${i}(${args}):variant==1?next${i}(${args}):oracle${i}(${args});break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){result=failure==FAILURE?"failure":failure==OVERRIDE?"override":failure.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+effects+":"+trace;}
public static void main(String[] args){int cases=0;for(int context=0;context<6;context++)for(int seed:new int[]{Integer.MIN_VALUE,-31,-1,0,1,31,Integer.MAX_VALUE})for(int flag:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(boolean keep:new boolean[]{false,true})for(Boolean boxed:new Boolean[]{false,true,null})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(Object lock:new Object[]{null,new Object()}){String want=take(context,2,${args});for(int variant=0;variant<2;variant++){String got=take(context,variant,${args});if(!want.equals(got))throw new AssertionError(context+":"+variant+":"+seed+":"+flag+":"+keep+":"+boxed+":"+inject+":"+mode+"\\n"+want+"\\n"+got);}cases++;}System.out.println(cases+" independent cases / 6 contexts");}}
`;
    const file = path.join(temporary, 'GuardedLocalNative.java'); fs.writeFileSync(file, fixture);
    run('javac', ['--release', '8', '-d', temporary, file]);
    assert.equal(run('java', ['-XX:-OmitStackTraceInFastThrow', '-Xmx128m', '-cp', temporary, 'GuardedLocalNative']), '30240 independent cases / 6 contexts');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});

test('native primitive arms preserve narrowing, signed zero, NaN and large integer precision', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-local-types-'));
  const run = (command, args) => {const r = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024}); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();};
  const models = [
    ['byte', '127', '-128', 'Byte.toString(value)'], ['short', '-32768', '32767', 'Short.toString(value)'],
    ['char', '0', '65535', 'Integer.toString(value)'], ['char', "'a'", "'z'", 'Integer.toString(value)'],
    ['long', '9007199254740993L', '-9007199254740993L', 'Long.toString(value)'],
    ['float', '-0.0f', '0x1.000002p0f', 'Integer.toHexString(Float.floatToRawIntBits(value))'],
    ['double', '1e300', '-0.0d', 'Long.toHexString(Double.doubleToRawLongBits(value))'],
    ['float', 'number', '-number', 'Integer.toHexString(Float.floatToRawIntBits(value))'],
    ['boolean', 'true', 'false', 'Boolean.toString(value)'],
  ];
  try {
    let methods = '';
    for (const [i, [type, a, b, show]] of models.entries()) {
      const old = `${type} value;int flag=captured;` + choice(a, b, 'flag==0', 'condition') + `return ${show};`;
      const next = fold(old, {parameters: [{name: 'number', type: 'float'}]}); assert.equal(next.assignmentsFolded, 1);
      const oracle = `${type} value;if(condition && captured==0)value=${a};else value=${b};return ${show};`;
      for (const [variant, source] of [['old', old], ['next', next.source], ['oracle', oracle]]) methods += `static String ${variant}${i}(boolean condition,int captured,float number){${source}}\n`;
    }
    const fixture = `public class GuardedLocalTypes {${methods}public static void main(String[] args){int cases=0;for(boolean condition:new boolean[]{false,true})for(int flag:new int[]{-1,0,1})for(float number:new float[]{Float.NaN,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY,-0.0f,0.0f,1.0f,-1.0f}){${models.map((_, i) => `if(!oracle${i}(condition,flag,number).equals(old${i}(condition,flag,number))||!oracle${i}(condition,flag,number).equals(next${i}(condition,flag,number)))throw new AssertionError("model ${i}");cases++;`).join('')}}System.out.println(cases+" typed cases / 9 models");}}`;
    const file = path.join(temporary, 'GuardedLocalTypes.java'); fs.writeFileSync(file, fixture);
    run('javac', ['--release', '8', '-d', temporary, file]);
    assert.equal(run('java', ['-Xmx128m', '-cp', temporary, 'GuardedLocalTypes']), '378 typed cases / 9 models');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
