'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {foldNestedStableGuardedFallbacks: fold} = require('../src/decompiler/javaAstEmitter');
const {shareExistingExitTails: finish} = require('../src/decompiler/cfr')._internals;
const parameters = [{name: 'enabled', type: 'boolean'}, {name: 'flag', type: 'int'}];
const fixed = source => {
  let recovered = 0, labels = 0;
  for (let iteration = 0; iteration < 128; iteration++) {
    const next = fold(source, {parameters, retainDiagnostics: true});
    if (!next.framesRecovered) return {source, recovered, labels};
    recovered++; labels += next.labelsRemoved; source = next.source;
  }
  throw new Error('recovery did not reach a fixed point');
};

test('terminal nested arms guard the complete continuation without copying actions', () => {
  const source = 'Frame:{if(outer()){if(enabled){before();if(flag==0)break Frame;}after();}}';
  const next = fold(source, {parameters, retainDiagnostics: true});
  assert.equal(next.framesRecovered, 1); assert.equal(next.labelsRemoved, 1);
  assert.equal(next.source, '{if(outer()){if(enabled){before();} if (!(enabled) || flag!=0) {after();}}}');
  assert.deepEqual(next.diagnostics.corridorKinds, ['IfStatement', 'BlockStatement']);
  assert.equal(next.diagnostics.frameScopeRetained, true);
  assert.equal(next.source.split('before()').length - 1, 1);
  assert.equal(next.source.split('after()').length - 1, 1);
  const body = [source]; finish(body, parameters.map(p => p.name), parameters);
  assert.ok(!body.join('\n').includes('break Frame'));
  assert.equal(fold(body.join('\n'), {parameters}).framesRecovered, 0);
});

test('other exits retain their original frame and can be recovered independently', () => {
  const source = 'Frame:{if(early())break Frame;if(enabled){before();if(flag==0)break Frame;}after();}';
  const next = fold(source, {parameters, retainDiagnostics: true});
  assert.equal(next.framesRecovered, 1); assert.equal(next.labelsRemoved, 0);
  assert.equal(next.diagnostics.labelRetained, true);
  assert.ok(next.source.startsWith('Frame:{if(early())break Frame;'));
  const chain = 'Frame:{if(enabled){first();if(flag==0)break Frame;}if(enabled){second();if(flag!=0)break Frame;}last();}';
  const result = fixed(chain); assert.equal(result.recovered, 2); assert.equal(result.labels, 1);
  for (const call of ['first()', 'second()', 'last()']) assert.equal(result.source.split(call).length - 1, 1);
});

test('declaration scopes and complete protected continuations stay inside their containers', () => {
  const source = 'Frame:{int value=read();if(outer()){if(enabled){before(value);if(flag==0)break Frame;}try{after(value);}finally{cleanup();}}}';
  const next = fold(source, {parameters, retainDiagnostics: true});
  assert.equal(next.framesRecovered, 1); assert.equal(next.labelsRemoved, 1);
  assert.ok(next.source.startsWith('{int value=read();'));
  assert.ok(next.source.includes('try{after(value);}finally{cleanup();}'));
  assert.equal(next.conditionCopiesAdded, 1); assert.equal(next.primitiveReadCopiesAdded, 1);
});

test('nonterminal and protected corridors, unstable predicates and guard-local dependencies refuse', () => {
  for (const source of [
    'Frame:{if(outer()){if(enabled){before();if(flag==0)break Frame;}after();}later();}',
    'Frame:{while(run()){if(enabled){before();if(flag==0)break Frame;}after();}}',
    'Frame:{try{if(enabled){before();if(flag==0)break Frame;}after();}finally{cleanup();}}',
    'Frame:{synchronized(lock){if(enabled){before();if(flag==0)break Frame;}after();}}',
    'Frame:{if(outer()){if(enabled){enabled=false;if(flag==0)break Frame;}after();}}',
    'Frame:{if(outer()){if(enabled){int local=read();if(local==0)break Frame;}after();}}',
    'Frame:{if(outer()){if(boxed){before();if(flag==0)break Frame;}after();}}',
    'Frame:{if(outer()){if(this.enabled){before();if(flag==0)break Frame;}after();}}',
  ]) assert.equal(fold(source, {parameters}).source, source, source);
  const good = 'Frame:{if(enabled){before();if(flag==0)break Frame;}after();}';
  for (const option of ['nestedContainers', 'preserveSharedFrames']) {
    const {foldStableGuardedFallbacks} = require('../src/decompiler/javaAstEmitter');
    assert.equal(foldStableGuardedFallbacks(good, {parameters, [option]: 1}).source, good);
  }
});

test('native nested and shared continuations preserve boxing failures, partial writes and finally priority', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-stable-native-'));
  const run = (cmd, args) => {
    const files = ['out', 'err'].map(name => path.join(directory, name));
    const fds = files.map(file => fs.openSync(file, 'w'));
    try {
      const result = spawnSync(cmd, args, {stdio: ['ignore', ...fds]});
      if (result.error) throw result.error;
      assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
      return fs.readFileSync(files[0], 'utf8').trim();
    } finally { fds.forEach(fd => fs.closeSync(fd)); }
  };
  const contexts = [
    source => source,
    source => `try{${source}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,
    source => `synchronized(lock){event(6);${source}}`,
    source => `try{${source}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(7);}`,
    source => `try{synchronized(lock){event(6);${source}}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,
    source => `{Object alias=lock;${source}if(alias!=lock)throw new AssertionError();}`,
  ];
  try {
    let methods = '', models = 0;
    for (const protect of contexts) for (const nested of [false, true]) for (const shared of [false, true]) {
      const prefix = 'event(0);value=value+seed;if(inject==1)throw FAILURE;' + (shared ? 'if(inject==3)break Frame;' : '');
      const suffix = 'event(2);value=value-1;if(inject==2)throw FAILURE;for(int j=0;j<2;j++){event(3);if(j==0)continue;break;}event(4);';
      const active = `if(enabled){${prefix}if(stop(boxed))break Frame;}${suffix}`;
      const old = protect('Frame:{' + (nested ? 'if(outer(outerBox)){' + active + '}' : active) + '}event(9);') + 'return snapshot();';
      const next = fixed(old); assert.equal(next.recovered, shared ? 2 : 1); assert.equal(next.labels, 1);
      // A separately stored decision is the reference oracle; it never repeats
      // enabled and does not use the emitted disjunction or rewritten tree.
      const oracleActive = `boolean blocked=false;if(enabled){${prefix.replace('break Frame;', 'break Oracle;')}blocked=stop(boxed);}if(!blocked){${suffix}}`;
      const oracleRegion = 'Oracle:{' + oracleActive + '}';
      const oracle = protect((nested ? 'if(outer(outerBox)){' + oracleRegion + '}' : oracleRegion) + 'event(9);') + 'return snapshot();';
      for (const [name, code] of [['old', old], ['next', next.source], ['oracle', oracle]]) {
        methods += `static String ${name}${models}(boolean enabled,Boolean outerBox,Boolean boxed,int seed,int inject,int mode){${code}}\n`;
      }
      models++;
    }
    const java = `public class NestedStableNative{
static int value,effects;static Object lock;static StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
static void event(int n){effects=effects*31+n;trace.append((char)('a'+n));}static boolean stop(Boolean b){event(1);return b.booleanValue();}static boolean outer(Boolean b){event(10);return b.booleanValue();}static String snapshot(){return value+":"+effects+":"+trace;}
${methods}
static String take(int model,int variant,boolean enabled,Boolean outerBox,Boolean boxed,int seed,int inject,int mode,boolean nullLock){value=seed;effects=seed;trace=new StringBuilder();lock=nullLock?null:new Object();String result;try{switch(model){${Array.from({length: models}, (_, i) => `case ${i}:result=variant==0?old${i}(enabled,outerBox,boxed,seed,inject,mode):variant==1?next${i}(enabled,outerBox,boxed,seed,inject,mode):oracle${i}(enabled,outerBox,boxed,seed,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+snapshot();}
public static void main(String[]args){int cases=0;for(int model=0;model<${models};model++)for(boolean enabled:new boolean[]{false,true})for(Boolean outerBox:new Boolean[]{false,true,null})for(Boolean boxed:new Boolean[]{false,true,null})for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true}){String want=take(model,2,enabled,outerBox,boxed,seed,inject,mode,nullLock);for(int variant=0;variant<2;variant++){String got=take(model,variant,enabled,outerBox,boxed,seed,inject,mode,nullLock);if(!want.equals(got))throw new AssertionError(model+":"+variant+":"+want+":"+got);}cases++;}System.out.println(cases+" cases / ${models} models");}}
`;
    const file = path.join(directory, 'NestedStableNative.java');
    fs.writeFileSync(file, java); run('javac', ['--release', '8', '-d', directory, file]);
    assert.equal(run('java', ['-Xmx128m', '-cp', directory, 'NestedStableNative']), '51840 cases / 24 models');
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
