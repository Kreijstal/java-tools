'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {shareExistingExitTails: recover} = require('../src/decompiler/cfr')._internals;

const fixtures = [
  'boolean first=true;boolean second=true;if(probe(a,0)){first=probe(b,1);if(first){second=probe(c,2);if(second){event(4);}}}event(5);',
  'int x=0;try{if(probe(a,0)){x=1;event(x);x=2;event(x);}if(probe(b,1)){x=3;event(x);x=4;event(x);}}finally{event(9);}',
  'Frame:{if(probe(a,0)){event(1);if(probe(b,2))break Frame;event(3);}event(4);}event(5);',
  'Frame:{event(1);if(probe(a,0)){while(more()){event(2);if(probe(b,3))break Frame;}break Frame;}event(4);}event(5);',
  'int iterations=0;while(true){if(probe(a,0)){event(1);break;}if(probe(b,2))break;event(3);if(++iterations==2)break;}event(4);',
  'Frame:{if(probe(a,0)){switch(selector){case 0:event(1);break Frame;default:event(2);break Frame;}}event(3);}event(4);',
  'int x;for(int i=0;i<2;i++){if(probe(a,0)){x=1;event(x);}if(probe(b,1)){x=2;event(x);}}',
  'if(probe(a,0)){event(1);if(probe(b,2)){event(3);event(4);event(5);event(6);event(7);event(8);event(9);event(10);}}else{event(3);event(4);event(5);event(6);event(7);event(8);event(9);event(10);}',
];
const render = source => {
  const body = [source];
  recover(body, ['a', 'b', 'c', 'selector']);
  return body.join('\n');
};

test('generic reconstruction has no environment feature gates', () => {
  const directory = path.dirname(require.resolve('../src/decompiler/cfr'));
  const source = fs.readdirSync(directory).filter(file => file.endsWith('.js'))
    .map(file => fs.readFileSync(path.join(directory, file), 'utf8')).join('\n');
  const reads = [...source.matchAll(/process\.env\.(CFR_JS_[A-Z_]+)/g)].map(match => match[1]);
  assert.ok(reads.every(name => /CFR_JS_(?:DEBUG_|PROFILE_)/.test(name)));
  fixtures.forEach(source => assert.notEqual(render(source), source));
});

test('retired feature switches cannot change automatic reconstruction', () => {
  const key = 'CFR_JS_CHAIN_LOCAL_BOOLEAN_ASSIGNMENTS';
  const previous = process.env[key];
  const expected = fixtures.map(render);
  try {
    process.env[key] = '0';
    assert.deepEqual(fixtures.map(render), expected);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('integral predicate evidence requires explicit agreement and rejects conflicting types', () => {
  const {integralConditionsFromCache} = require('../src/decompiler/cfr')._internals;
  const cache = evidence => new Map(evidence.map((integralComparison, index) => [index, {
    terminator: {op: 'ifeq'}, stack: [],
    branchCondition: {code: 'left == right', type: 'boolean', precedence: 60, integralComparison},
  }]));
  assert.deepEqual([...integralConditionsFromCache(cache([true]))].sort(), ['left != right', 'left == right']);
  for (const evidence of [[false], [undefined], [true, false], [true, undefined]])
    assert.equal(integralConditionsFromCache(cache(evidence)).size, 0);
});

test('combined default passes preserve native effects, exceptions and monitors', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'default-readability-native-'));
  const run = (command, args) => {
    const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
    const descriptors = files.map(file => fs.openSync(file, 'w'));
    try {
      const result = spawnSync(command, args, {stdio: ['ignore', ...descriptors]});
      if (result.error) throw result.error;
      assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
      return fs.readFileSync(files[0], 'utf8').trim();
    } finally {descriptors.forEach(descriptor => fs.closeSync(descriptor));}
  };
  const wraps = [source => source,
    source => `try{${source}}finally{event(11);if(mode==1)throw OVERRIDE;}`,
    source => `synchronized(lock){${source}}`,
    source => `try{${source}}catch(IllegalStateException error){event(12);if(error!=FAILURE)throw error;}finally{event(11);}`];
  try {
    let methods = '', models = 0;
    const outgoingAssignment = 'String selected;Frame:{if(probe(a,0)){event(1);if(probe(b,2)){selected="primary";event(3);break Frame;}}selected="fallback";event(4);}event(selected.length());';
    for (const original of [...fixtures, outgoingAssignment]) for (const wrap of wraps) {
      const before = wrap(original);
      for (const [variant, source] of [['original', before], ['readable', render(before)]])
        methods += `static void ${variant}${models}(Boolean a,Boolean b,Boolean c,int selector,int mode){${source}}\n`;
      models++;
    }
    const java = `public final class DefaultReadabilityOracle {
      static int count,failAt,loops; static Object lock; static StringBuilder trace;
      static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
      static void event(int value){trace.append(value).append(lock!=null&&Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}
      static Boolean probe(Boolean value,int event){event(event);return value;}
      static boolean more(){return loops++<2;}
      ${methods}
      static String take(int model,boolean candidate,Boolean a,Boolean b,Boolean c,int selector,int mode,boolean nullLock){
        count=loops=0;lock=nullLock?null:new Object();trace=new StringBuilder();String result="ok";
        try{switch(model){${Array.from({length: models}, (_, i) => `case ${i}:if(candidate)readable${i}(a,b,c,selector,mode);else original${i}(a,b,c,selector,mode);break;`).join('')}default:throw new AssertionError();}}
        catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}
        if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("leaked monitor");
        return result+":"+count+":"+loops+":"+trace;
      }
      public static void main(String[]args){int comparisons=0;
        for(int model=0;model<${models};model++)for(Boolean a:new Boolean[]{false,true,null})for(Boolean b:new Boolean[]{false,true,null})for(Boolean c:new Boolean[]{false,true,null})for(int selector=0;selector<2;selector++)for(int mode=0;mode<2;mode++)for(boolean nullLock:new boolean[]{false,true})for(failAt=-1;failAt<14;failAt++){
          String expected=take(model,false,a,b,c,selector,mode,nullLock),actual=take(model,true,a,b,c,selector,mode,nullLock);
          if(!expected.equals(actual))throw new AssertionError(model+":"+a+":"+b+":"+selector+":"+failAt+":"+expected+":"+actual);comparisons++;
        }System.out.println(comparisons);
      }
    }`;
    fs.writeFileSync(path.join(directory, 'DefaultReadabilityOracle.java'), java);
    run('javac', ['--release', '8', '-d', directory, path.join(directory, 'DefaultReadabilityOracle.java')]);
    assert.equal(run('java', ['-Xmx128m', '-cp', directory, 'DefaultReadabilityOracle']), '116640');
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
