'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {recoverArrayIndexIncrements: recover} = require('../src/decompiler/javaAstEmitter');
const {decompileClassFile} = require('../src/decompiler/cfr');

const parameters = ['src', 'dst'].map(name => ({name, type: 'Object[]'}))
  .concat(['s', 'd'].map(name => ({name, type: 'int'})));
const captures = 'int incrementValue$0=0;int incrementValue$1=0;';
const forward = 'incrementValue$0=d;d++;incrementValue$1=s;s++;dst[incrementValue$0]=src[incrementValue$1];';

test('array recovery accounts for both captures and reaches a fixed point', () => {
  const next = recover(captures + forward, {parameters});
  assert.equal(next.capturesFolded, 2);
  assert.equal(next.source, 'dst[d++]=src[s++];');
  assert.equal(recover(next.source, {parameters}).source, next.source);
  assert.equal(recover(next.source, {parameters}).capturesFolded, 0);
  const zero = recover('int incrementValue$0=0;incrementValue$0=d;d--;dst[incrementValue$0]=0;', {parameters});
  assert.equal(zero.capturesFolded, 1);
  assert.equal(zero.source, 'dst[d--]=0;');
  const locals = recover('int[] dst=null;int d=0;int incrementValue$0=0;incrementValue$0=d;d++;dst[incrementValue$0]=0;');
  assert.equal(locals.capturesFolded, 1);
  assert.match(locals.source, /dst\[d\+\+\]=0/);
  const inline = recover('while(active){int incrementValue$0=d;d++;int incrementValue$1=s;s++;dst[incrementValue$0]=src[incrementValue$1];}',
    {parameters: [...parameters, {name: 'active', type: 'boolean'}]});
  assert.equal(inline.capturesFolded, 2);
  assert.equal(inline.source, 'while(active){dst[d++]=src[s++];}');
});

test('fields, effects, incomplete bindings and escaping captures keep original statements', () => {
  const cases = [
    captures + forward + 'use(incrementValue$0);',
    captures + forward.replace('d++;', 'step();d++;'),
    captures + forward.replace('d++;', 'd+=2;'),
    captures + forward.replace('d++;', '++d;'),
    captures + forward.replace('dst[', 'Holder.dst['),
    captures + forward.replace('src[', 'getSource()['),
    captures + forward.replace('dst[incrementValue$0]=', 'dst[incrementValue$0]+='),
    captures + forward.replace('src[incrementValue$1]', 'src[incrementValue$1+1]'),
    captures + forward + '{int d=0;use(d);}',
    captures + forward + 'use(Holder.incrementValue$0);',
    captures.replace('incrementValue$0=0', 'incrementValue$0=effect()') + forward,
    captures + 'incrementValue$0=d;d++;dst[d]=src[incrementValue$0];',
    captures + 'incrementValue$0=d;d++;dst[incrementValue$0]=effect();',
    captures + 'incrementValue$0=d;d++;dst[incrementValue$0]=Holder.value;',
    captures + 'incrementValue$0=d;try{d++;dst[incrementValue$0]=0;}finally{cleanup();}',
    captures + 'incrementValue$0=d;d++;synchronized(lock){dst[incrementValue$0]=0;}',
    captures + forward + ' /* keep */',
    captures + forward + '\\u000a',
    captures + forward.replace('dst[incrementValue$0]', 'dst[incrementValue$0'),
    captures + forward + 'Runnable callback=()->{use(d);};',
    captures + forward + 'class Local{}',
  ];
  for (const source of cases) {
    assert.equal(recover(source, {parameters}).capturesFolded, 0, source);
    assert.equal(recover(source, {parameters}).source, source);
  }
  for (const params of [[], null, [{name: 'd', type: 'Integer'}, {name: 'dst', type: 'Object[]'}],
    [...parameters, {name: 'd', type: 'int'}], [{name: 'bad.name', type: 'int'}]])
    assert.equal(recover(captures + forward, {parameters: params}).source, captures + forward);
});

function temporary(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'array-increments-native-'));
  function run(command, args) {
    const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
    const descriptors = files.map(file => fs.openSync(file, 'w'));
    try {
      const result = spawnSync(command, args, {stdio: ['ignore', ...descriptors], timeout: 30000,
        env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'}});
      if (result.error) throw result.error;
      assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
      return fs.readFileSync(files[0], 'utf8');
    } finally {descriptors.forEach(fd => fs.closeSync(fd));}
  }
  try {fn(directory, run);} finally {fs.rmSync(directory, {recursive: true, force: true});}
}

test('native array exceptions, partial writes, overlap, overflow and cleanup retain counter order', () => {
  const variants = [
    'incrementValue$0=d;d++;dst[incrementValue$0]=0;',
    forward,
    forward.replaceAll('++;', '--;'),
    forward.replace('incrementValue$1=s;s++;', 'incrementValue$1=d;d++;'),
    'synchronized(lock){' + forward + '}',
    'for(int round=0;round<3;round++){' + forward + '}',
    'for(int round=0;round<3;round++){int incrementValue$2=d;d++;int incrementValue$3=s;s++;dst[incrementValue$2]=src[incrementValue$3];}',
  ];
  temporary((directory, run) => {
    const methods = [];
    variants.forEach((body, index) => {
      const source = captures + 'try{' + body + '}finally{trace=s+":"+d+":"+java.util.Arrays.toString(src)+":"+java.util.Arrays.toString(dst);cleanups++;}';
      const next = recover(source, {parameters});
      assert.ok(next.capturesFolded > 0);
      assert.equal(recover(next.source, {parameters}).capturesFolded, 0);
      for (const [name, text] of [['original', source], ['rebuilt', next.source]])
        methods.push(`static void ${name}${index}(Object[] src,Object[] dst,int s,int d){${text}}`);
    });
    const java = `public class ArrayIncrementTrace {
      static final Object lock=new Object();static String trace;static int cleanups;
      ${methods.join('\n')}
      static Object[] array(int kind,int length){if(kind==0)return null;Object[] a=kind==1?new Object[length]:new String[length];for(int i=0;i<length;i++)a[i]=kind==1&&i%2==0?Integer.valueOf(i):"v"+i;return a;}
      static String run(boolean rebuild,int variant,int sk,int dk,int sl,int dl,int s,int d){
        Object[] src=array(sk,sl),dst=dk==3?src:array(dk,dl);trace="";cleanups=0;String failure="none";
        try{switch(variant){${variants.map((_, i) => `case ${i}:if(rebuild)rebuilt${i}(src,dst,s,d);else original${i}(src,dst,s,d);break;`).join('')}}}
        catch(RuntimeException e){failure=e.getClass().getSimpleName();}
        return failure+":"+cleanups+":"+trace;
      }
      public static void main(String[] args){int cases=0;int[] indices={-2,-1,0,1,3,4,5,Integer.MIN_VALUE,Integer.MAX_VALUE};
        for(int v=0;v<${variants.length};v++)for(int sk=0;sk<3;sk++)for(int dk=0;dk<4;dk++)for(int sl=0;sl<6;sl++)for(int dl=0;dl<6;dl++)for(int s:indices)for(int d:indices){
          String a=run(false,v,sk,dk,sl,dl,s,d),b=run(true,v,sk,dk,sl,dl,s,d);if(!a.equals(b))throw new AssertionError(v+":"+sk+":"+dk+":"+s+":"+d+":"+a+" != "+b);cases++;
        }
        String sourceFailure=run(true,1,1,0,0,0,0,0);
        if(!sourceFailure.startsWith("ArrayIndexOutOfBoundsException:1:1:1:"))throw new AssertionError(sourceFailure);
        String targetFailure=run(true,1,1,0,1,0,0,0);
        if(!targetFailure.startsWith("NullPointerException:1:1:1:"))throw new AssertionError(targetFailure);
        String overflow=run(true,1,0,0,0,0,Integer.MAX_VALUE,Integer.MAX_VALUE);
        if(!overflow.startsWith("NullPointerException:1:-2147483648:-2147483648:"))throw new AssertionError(overflow);
        String storeFailure=run(true,1,1,2,1,1,0,0);
        if(!storeFailure.startsWith("ArrayStoreException:1:1:1:"))throw new AssertionError(storeFailure);
        String monitored=run(true,4,0,0,0,0,0,0);
        if(Thread.holdsLock(lock)||!monitored.startsWith("NullPointerException:1:1:1:"))throw new AssertionError("monitor cleanup");
        System.out.println("native-array-increments:"+cases+":oracles:5");
      }
    }`;
    const file = path.join(directory, 'ArrayIncrementTrace.java');fs.writeFileSync(file, java);
    run('javac', ['--release', '8', file]);
    assert.equal(run('java', ['-cp', directory, 'ArrayIncrementTrace']).trim(), 'native-array-increments:244944:oracles:5');
  });
});

test('owned decompiler emits post-increment array stores and compiles its output', () => {
  temporary((directory, run) => {
    const file = path.join(directory, 'ArrayIncrementFixture.java');
    fs.writeFileSync(file, 'public class ArrayIncrementFixture {public static void copy(int[] a,int x,int[] b,int y){b[y++]=a[x++];} public static void clear(int[] b,int i){b[i++]=0;} public static void reverse(Object[] a,int x,Object[] b,int y){b[y--]=a[x--];}}');
    run('javac', ['--release', '8', file]);
    const source = decompileClassFile(path.join(directory, 'ArrayIncrementFixture.class'));
    assert.equal(typeof source, 'string');
    assert.ok(!source.includes('incrementValue$'));
    assert.match(source, /\[param3\+\+\] = param0\[param1\+\+\]/);
    assert.match(source, /\[param1\+\+\] = 0/);
    assert.match(source, /\[param3--\] = param0\[param1--\]/);
    fs.writeFileSync(file, source);
    run('javac', ['--release', '8', file]);
  });
});
