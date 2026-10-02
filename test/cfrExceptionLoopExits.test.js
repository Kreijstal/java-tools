'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');

function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const fds = files.map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {
      stdio: ['ignore', ...fds], timeout: 15000,
      env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'},
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally { fds.forEach(fd => fs.closeSync(fd)); }
}

test('nonthrowing return tails preserve values, effects, shared joins, lock exits and outside failures', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-region-return-tails-'));
  const previous=process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const native=path.join(temporary,'native');fs.mkdirSync(native);
    let assembly='.version 49 0\n.class public super ReturnTails\n.super java/lang/Object\n';
    for(const name of ['choose','outside','shared']) {
      const tail=()=>name==='outside'?`iload_2\n invokestatic Method ReturnEffects tail (II)I\n ireturn`:'ireturn';
      assembly+=`.method public static ${name} : (III)I
        .code stack 2 locals 4
        .catch java/lang/RuntimeException from Ltry to Lhandler using Lhandler
      Ltry:
        iload_1
        invokestatic Method ReturnEffects work (I)V
        iload_0
        ifeq Lzero
        iload_0
        iconst_1
        if_icmpeq Lone
        bipush 30
        goto LotherReturn
      Lzero:
        bipush 10
        goto LzeroReturn
      Lone:
        bipush 20
        goto LoneReturn
      Lhandler:
        astore_3
        aload_3
        invokestatic Method ReturnEffects caught (Ljava/lang/Throwable;)V
        iconst_m1
        ${name==='shared'?'goto LzeroReturn':'ireturn'}
      LotherReturn:
        ${tail()}
      LzeroReturn:
        ${tail()}
      LoneReturn:
        ${tail()}
        .end code
      .end method\n`;
    }
    for(const [name,descriptor,prefix,slots,zero] of [
      ['integer','I','i',1,'iconst_0'],['wide','J','l',2,'lconst_0'],
      ['single','F','f',1,'fconst_0'],['real','D','d',2,'dconst_0'],
      ['reference','Ljava/lang/Object;','a',1,'aconst_null'],
    ])assembly+=`.method public static ${name} : (${descriptor}I)${descriptor}
      .code stack 2 locals ${slots+2}
      .catch java/lang/RuntimeException from Ltry to Lhandler using Lhandler
    Ltry:
      iload ${slots}
      invokestatic Method ReturnEffects work (I)V
      ${prefix}load_0
      goto Lreturn
    Lhandler:
      astore ${slots+1}
      aload ${slots+1}
      invokestatic Method ReturnEffects caught (Ljava/lang/Throwable;)V
      ${zero}
      ${prefix}return
    Lreturn:
      ${prefix}return
      .end code
    .end method\n`;
    assembly+=`.method public static empty : (I)V
      .code stack 1 locals 2
      .catch java/lang/RuntimeException from Ltry to Lhandler using Lhandler
    Ltry:
      iload_0
      invokestatic Method ReturnEffects work (I)V
      goto Lreturn
    Lhandler:
      astore_1
      aload_1
      invokestatic Method ReturnEffects caught (Ljava/lang/Throwable;)V
      return
    Lreturn:
      return
      .end code
    .end method
    .end class`;
    const classFile=path.join(native,'ReturnTails.class');assembleJasminSource(assembly,classFile);
    const effects=`class ReturnEffects {
      static String trace;static Throwable last;
      @SuppressWarnings("unchecked") static <T extends Throwable> RuntimeException raise(Throwable error)throws T {throw (T)error;}
      static void fail(int kind) {
        if(kind==0)return;
        last=kind==1?new IllegalArgumentException():kind==2?new IllegalStateException():kind==3?new AssertionError():new java.io.IOException();
        throw ReturnEffects.<RuntimeException>raise(last);
      }
      static void work(int kind){trace+="W"+kind;fail(kind);}
      static void caught(Throwable error){if(error!=last)throw new AssertionError("throwable identity");trace+="C";}
      static int tail(int value,int kind){trace+="T"+value+":"+kind;fail(kind);return value;}
      static void lockedWork(int kind){if(!Thread.holdsLock(ReturnLocks.lock()))throw new AssertionError("work lock");work(kind);}
      static int unlockedTail(int value,int kind){if(Thread.holdsLock(ReturnLocks.lock()))throw new AssertionError("tail lock");return tail(value,kind);}
    }`;
    const locks=`public class ReturnLocks {
      static final Object LOCK=new Object();
      static Object lock(){return LOCK;}
      public static int inside(int failure) {
        synchronized(LOCK) {
          try {ReturnEffects.lockedWork(failure);return 10;}
          catch(RuntimeException error){if(!Thread.holdsLock(LOCK))throw new AssertionError("catch lock");ReturnEffects.caught(error);return -1;}
        }
      }
      public static int outside(int failure) {
        try {synchronized(LOCK){ReturnEffects.lockedWork(failure);return 11;}}
        catch(RuntimeException error){if(Thread.holdsLock(LOCK))throw new AssertionError("catch release");ReturnEffects.caught(error);return -1;}
      }
      public static int after(int failure) {
        synchronized(LOCK){ReturnEffects.lockedWork(0);}
        return ReturnEffects.unlockedTail(12,failure);
      }
    }`;
    const driver=`class ReturnTailRunner {
      static int count;
      static String value(Object result) {
        if(result instanceof Float)return "f:"+Integer.toHexString(Float.floatToRawIntBits((Float)result));
        if(result instanceof Double)return "d:"+Long.toHexString(Double.doubleToRawLongBits((Double)result));
        return String.valueOf(result);
      }
      static void invoke(String name,Class<?>[] types,Object[] arguments)throws Exception {
        ReturnEffects.trace="";ReturnEffects.last=null;String outcome;
        try{
          Object result=ReturnTails.class.getDeclaredMethod(name,types).invoke(null,arguments);
          if(name.equals("reference")&&(Integer)arguments[1]==0&&result!=arguments[0])throw new AssertionError("return reference identity");
          outcome=value(result);
        }
        catch(java.lang.reflect.InvocationTargetException error) {
          Throwable cause=error.getCause();if(cause!=ReturnEffects.last)throw new AssertionError("escaping throwable identity");
          outcome=cause.getClass().getSimpleName();
        }
        System.out.println(name+":"+outcome+":"+ReturnEffects.trace);count++;
      }
      public static void main(String[] args)throws Exception {
        int[] ints={Integer.MIN_VALUE,-7,-1,0,1,2,7,Integer.MAX_VALUE};
        for(String name:new String[]{"choose","outside","shared"})for(int mode:ints)for(int work=0;work<5;work++)for(int tail=0;tail<5;tail++)
          invoke(name,new Class<?>[]{int.class,int.class,int.class},new Object[]{mode,work,tail});
        long[] longs={Long.MIN_VALUE,-7,-1,0,1,2,7,Long.MAX_VALUE};
        int[] floats={0x80000000,0,0xbf800000,0x3f800000,0xff800000,0x7f800000,0x7fc12345,0xffc54321};
        long[] doubles={0x8000000000000000L,0,0xbff0000000000000L,0x3ff0000000000000L,0xfff0000000000000L,0x7ff0000000000000L,0x7ff8123456789abcL,0xfff8abcdef012345L};
        for(int work=0;work<5;work++) {
          for(int x:ints)invoke("integer",new Class<?>[]{int.class,int.class},new Object[]{x,work});
          for(long x:longs)invoke("wide",new Class<?>[]{long.class,int.class},new Object[]{x,work});
          for(int x:floats)invoke("single",new Class<?>[]{float.class,int.class},new Object[]{Float.intBitsToFloat(x),work});
          for(long x:doubles)invoke("real",new Class<?>[]{double.class,int.class},new Object[]{Double.longBitsToDouble(x),work});
          for(Object x:new Object[]{null,"","identity"})invoke("reference",new Class<?>[]{Object.class,int.class},new Object[]{x,work});
          invoke("empty",new Class<?>[]{int.class},new Object[]{work});
        }
        for(String name:new String[]{"inside","outside","after"})for(int failure=0;failure<5;failure++) {
          ReturnEffects.trace="";ReturnEffects.last=null;String outcome;
          try{outcome=""+ReturnLocks.class.getDeclaredMethod(name,int.class).invoke(null,failure);}
          catch(java.lang.reflect.InvocationTargetException error){if(error.getCause()!=ReturnEffects.last)throw new AssertionError("lock throwable identity");outcome=error.getCause().getClass().getSimpleName();}
          if(Thread.holdsLock(ReturnLocks.lock()))throw new AssertionError("lock not released");
          System.out.println("lock:"+name+":"+failure+":"+outcome+":"+ReturnEffects.trace);count++;
        }
        if(count!=795)throw new AssertionError("coverage "+count);System.out.println("complete:"+count);
      }
    }`;
    for(const [name,text] of Object.entries({ReturnEffects:effects,ReturnLocks:locks,ReturnTailRunner:driver}))fs.writeFileSync(path.join(native,name+'.java'),text);
    run('javac',['--release','8','-classpath',native,'-d',native,...['ReturnEffects','ReturnLocks','ReturnTailRunner'].map(name=>path.join(native,name+'.java'))],native);
    const expected=run('java',['-cp',native,'ReturnTailRunner'],native);assert.match(expected,/complete:795\n$/);
    for(const forced of [false,true]) {
      if(forced)process.env.CFR_JS_FORCE_STATE_MACHINE='1';else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const source=decompileClassFile(classFile);assertNoFallback(source);
      if(!forced) {
        const body=name=>source.match(new RegExp('public static [^\\n]+ '+name+'\\([^)]*\\) \\{([\\s\\S]*?)(?=\\n    public static|\\n})'))?.[1];
        assert.ok(body('choose')&&!body('choose').includes('decompiledRegionSelector'),'pure returns do not allocate a selector');
        assert.ok(body('outside')?.includes('decompiledRegionSelector'),'throwing tails retain explicit external routing');
        assert.match(body('shared'),/\n        return /,'shared try/catch return stays outside the catch scope');
      }
      const rebuilt=path.join(temporary,forced?'forced':'structured');fs.mkdirSync(rebuilt);
      // The forced dispatcher deliberately refuses explicit monitors instead
      // of emitting unsynchronized Java. Test that refusal; the forced return
      // fixture uses the original lock helper as a native dependency. Only the
      // normal reconstruction is used for the lock-exit differential proof.
      let lockSource=locks;
      if(forced)assert.throws(()=>decompileClassFile(path.join(native,'ReturnLocks.class')),
        /fallback marker[^\n]*monitorenter/);
      else {lockSource=decompileClassFile(path.join(native,'ReturnLocks.class'));assertNoFallback(lockSource);}
      for(const [name,text] of Object.entries({ReturnTails:source,ReturnEffects:effects,ReturnLocks:lockSource,ReturnTailRunner:driver}))fs.writeFileSync(path.join(rebuilt,name+'.java'),text);
      run('javac',['--release','8','-d',rebuilt,...['ReturnTails','ReturnEffects','ReturnLocks','ReturnTailRunner'].map(name=>path.join(rebuilt,name+'.java'))],rebuilt);
      assert.equal(run('java',['-cp',rebuilt,'ReturnTailRunner'],rebuilt),expected);
    }
  } finally {
    if(previous===undefined)delete process.env.CFR_JS_FORCE_STATE_MACHINE;else process.env.CFR_JS_FORCE_STATE_MACHINE=previous;
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});

test('handler cleanup cannot enter a shadowed sibling catch during a loop exit', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-shadowed-loop-exits-'));
  const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const effects = `class Effects {
      static StringBuilder trace; static Throwable failed;
      @SuppressWarnings("unchecked")
      static <T extends Throwable> RuntimeException raise(Throwable error) throws T { throw (T) error; }
      static void fail(int kind) {
        if (kind == 0) return;
        if (kind == 1) failed = new IllegalArgumentException();
        else if (kind == 2) failed = new IllegalStateException();
        else if (kind == 3) failed = new AssertionError();
        else failed = new java.io.IOException();
        throw Effects.<RuntimeException>raise(failed);
      }
      static int next(int step, int throwAt, int kind) {
        trace.append('W').append(step).append(',');
        if (step == throwAt) fail(kind);
        return step * 31;
      }
      static void cleanup(int kind) { trace.append('C'); fail(kind); }
      static void narrow() { trace.append('N'); }
    }`;
    const driver = `class ShadowedRunner { public static void main(String[] args) {
      for (int mode = 0; mode < 4; mode++) for (int throwAt = -1; throwAt <= 4; throwAt++)
        for (int workKind = 0; workKind < 5; workKind++) for (int cleanupKind = 0; cleanupKind < 5; cleanupKind++) {
          Effects.trace = new StringBuilder(); Effects.failed = null; String result;
          try { result = "" + ShadowedLoopExits.compute(mode, throwAt, workKind, cleanupKind); }
          catch (Throwable error) { result = error.getClass().getSimpleName()+":"+(error == Effects.failed); }
          System.out.println(mode+":"+throwAt+":"+workKind+":"+cleanupKind+":"+result+":"+Effects.trace);
        }
    } }`;
    for (const [first, second, shadowed] of [
      ['java/lang/RuntimeException', 'java/lang/IllegalArgumentException', true],
      ['java/lang/Throwable', 'java/lang/IllegalArgumentException', true],
      ['java/lang/IllegalArgumentException', 'java/lang/RuntimeException', false],
    ]) {
      const native = path.join(temporary, first.replaceAll('/', '_'));
      fs.mkdirSync(native);
      const assembly = `.version 49 0
        .class public super ShadowedLoopExits
        .super java/lang/Object
        .method public static compute : (IIII)I
          .code stack 3 locals 7
          .catch ${first} from Ltry to LtryEnd using Lfirst
          .catch ${second} from Ltry to LtryEnd using Lsecond
          iconst_0
          istore 4
          iconst_0
          istore 5
        Lloop:
          iload 5
          iconst_3
          if_icmpge Ldone
          iinc 5 1
        Ltry:
          iload 5
          iload_1
          iload_2
          invokestatic Method Effects next (III)I
          istore 4
        LtryEnd:
          goto Lexit
        Lfirst:
          astore 6
          iload_3
          invokestatic Method Effects cleanup (I)V
          bipush -7
          istore 4
          goto Lexit
        Lsecond:
          astore 6
          invokestatic Method Effects narrow ()V
          bipush -99
          istore 4
          goto Lexit
        Lexit:
          iload_0
          ifeq Lloop
          iload_0
          iconst_1
          if_icmpeq Ldone
          iload_0
          iconst_2
          if_icmpeq Lreturn
          iinc 5 1
          iload 5
          iload_1
          iload_2
          invokestatic Method Effects next (III)I
          istore 4
          goto Lloop
        Lreturn:
          iload 4
          ireturn
        Ldone:
          iload 4
          ireturn
          .end code
        .end method
        .end class`;
      const classFile = path.join(native, 'ShadowedLoopExits.class');
      assembleJasminSource(assembly, classFile);
      fs.writeFileSync(path.join(native, 'Effects.java'), effects);
      fs.writeFileSync(path.join(native, 'ShadowedRunner.java'), driver);
      run('javac', ['--release', '8', '-cp', native, '-d', native,
        path.join(native, 'Effects.java'), path.join(native, 'ShadowedRunner.java')], native);
      const expected = run('java', ['-cp', native, 'ShadowedRunner'], native);
      assert.equal(expected.trim().split('\n').length, 600);
      assert.match(expected, /IOException:true/);
      assert.doesNotMatch(expected, /:false:/);
      if (shadowed) assert.doesNotMatch(expected, /,N/);
      else assert.match(expected, /,N/);
      for (const forced of [false, true]) {
        if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
        else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
        const diagnostics = [];
        const source = decompileClassFile(classFile, {diagnostics});
        assertNoFallback(source);
        const rebuilt = path.join(native, forced ? 'forced' : 'ordinary');
        fs.mkdirSync(rebuilt);
        fs.writeFileSync(path.join(rebuilt, 'ShadowedLoopExits.java'), source);
        fs.writeFileSync(path.join(rebuilt, 'Effects.java'), effects);
        fs.writeFileSync(path.join(rebuilt, 'ShadowedRunner.java'), driver);
        run('javac', ['--release', '8', '-d', rebuilt,
          ...['ShadowedLoopExits', 'Effects', 'ShadowedRunner'].map(name => path.join(rebuilt, name + '.java'))], rebuilt);
        const actual = run('java', ['-cp', rebuilt, 'ShadowedRunner'], rebuilt);
        const actualLines = actual.trim().split('\n'), expectedLines = expected.trim().split('\n');
        assert.equal(actualLines.length, expectedLines.length);
        expectedLines.forEach((line, index) => assert.equal(actualLines[index], line,
          `${first} before ${second}, forced=${forced}, scenario=${index}`));
        assert.equal(source.includes('switch (statePc)'), forced || shadowed, JSON.stringify(diagnostics));
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('loop exits preserve table priority between nested protected ranges', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-nested-priority-loop-exits-'));
  const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const effects = `class Effects {
      static StringBuilder trace; static Throwable failed;
      static int work(int step, int throwAt) {
        trace.append('W').append(step).append(',');
        if (step == throwAt) { failed = new IllegalArgumentException(); throw (IllegalArgumentException) failed; }
        return step * 31;
      }
      static void inner(int kind) {
        trace.append('I');
        if (kind != 0) { failed = new IllegalArgumentException(); throw (IllegalArgumentException) failed; }
      }
      static void outer(int kind) {
        trace.append('O');
        if (kind != 0) { failed = new AssertionError(); throw (AssertionError) failed; }
      }
    }`;
    const driver = `class PriorityRunner { public static void main(String[] args) {
      for (int mode = 0; mode < 4; mode++) for (int throwAt = -1; throwAt <= 4; throwAt++)
        for (int innerKind = 0; innerKind < 2; innerKind++) for (int outerKind = 0; outerKind < 2; outerKind++) {
          Effects.trace = new StringBuilder(); Effects.failed = null; String result;
          try { result = "" + PriorityLoopExits.compute(mode, throwAt, innerKind, outerKind); }
          catch (Throwable error) { result = error.getClass().getSimpleName()+":"+(error == Effects.failed); }
          System.out.println(mode+":"+throwAt+":"+innerKind+":"+outerKind+":"+result+":"+Effects.trace);
        }
    } }`;
    for (const outerFirst of [true, false]) {
      const native = path.join(temporary, outerFirst ? 'outer-first' : 'inner-first');
      fs.mkdirSync(native);
      const catches = [
        '.catch java/lang/RuntimeException from Ltry to Lexit using Louter',
        '.catch java/lang/IllegalArgumentException from Ltry to LtryEnd using Linner',
      ];
      if (!outerFirst) catches.reverse();
      const assembly = `.version 49 0
        .class public super PriorityLoopExits
        .super java/lang/Object
        .method public static compute : (IIII)I
          .code stack 2 locals 7
          ${catches.join('\n')}
          iconst_0
          istore 4
          iconst_0
          istore 5
        Lloop:
          iload 5
          iconst_3
          if_icmpge Ldone
          iinc 5 1
        Ltry:
          iload 5
          iload_1
          invokestatic Method Effects work (II)I
          istore 4
        LtryEnd:
          goto Lexit
        Linner:
          astore 6
          iload_2
          invokestatic Method Effects inner (I)V
          bipush -7
          istore 4
          goto Lexit
        Lexit:
          goto Ltransfer
        Louter:
          astore 6
          iload_3
          invokestatic Method Effects outer (I)V
          bipush -99
          istore 4
        Ltransfer:
          iload_0
          ifeq Lloop
          iload_0
          iconst_1
          if_icmpeq Ldone
          iload_0
          iconst_2
          if_icmpeq Lreturn
          iinc 5 1
          iload 5
          iload_1
          invokestatic Method Effects work (II)I
          istore 4
          goto Lloop
        Lreturn:
          iload 4
          ireturn
        Ldone:
          iload 4
          ireturn
          .end code
        .end method
        .end class`;
      const classFile = path.join(native, 'PriorityLoopExits.class');
      assembleJasminSource(assembly, classFile);
      const names = ['PriorityLoopExits', 'Effects', 'PriorityRunner'];
      fs.writeFileSync(path.join(native, 'Effects.java'), effects);
      fs.writeFileSync(path.join(native, 'PriorityRunner.java'), driver);
      run('javac', ['--release', '8', '-cp', native, '-d', native,
        ...names.slice(1).map(name => path.join(native, name + '.java'))], native);
      const expected = run('java', ['-cp', native, 'PriorityRunner'], native);
      assert.equal(expected.trim().split('\n').length, 96);
      assert.match(expected, /AssertionError:true/);
      assert.doesNotMatch(expected, /:false:/);
      if (outerFirst) assert.doesNotMatch(expected, /,I/);
      else assert.match(expected, /,I/);
      for (const forced of [false, true]) {
        if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
        else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
        const diagnostics = [];
        const source = decompileClassFile(classFile, {diagnostics});
        assertNoFallback(source);
        const rebuilt = path.join(native, forced ? 'forced' : 'ordinary');
        fs.mkdirSync(rebuilt);
        for (const [name, text] of Object.entries({PriorityLoopExits: source, Effects: effects,
          PriorityRunner: driver})) fs.writeFileSync(path.join(rebuilt, name + '.java'), text);
        run('javac', ['--release', '8', '-d', rebuilt,
          ...names.map(name => path.join(rebuilt, name + '.java'))], rebuilt);
        const actual = run('java', ['-cp', rebuilt, 'PriorityRunner'], rebuilt);
        const actualLines = actual.trim().split('\n'), expectedLines = expected.trim().split('\n');
        assert.equal(actualLines.length, expectedLines.length);
        expectedLines.forEach((line, index) => assert.equal(actualLines[index], line,
          `outerFirst=${outerFirst}, forced=${forced}, scenario=${index}`));
        assert.equal(source.includes('switch (statePc)'), forced || outerFirst, JSON.stringify(diagnostics));
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('finally cleanup preserves pending loop exits, returns and throwable identity', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-finally-loop-exits-'));
  const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const original = `public class FinallyLoopExits {
      public static int compute(int mode, int throwAt, int cleanupAt) {
        int result = 0, step = 0, cleanups = 0;
        outer: for (int i = 0; i < 3; i++) {
          inner: for (int j = 0; j < 3; j++) {
            try {
              result = Effects.next(result, ++step, throwAt, i * 10 + j);
              switch (mode) {
                case 0: continue inner;
                case 1: continue outer;
                case 2: break inner;
                case 3: break outer;
                case 4: return result;
                default: result = result * 31 + 100;
              }
            } catch (IllegalArgumentException error) {
              Effects.mark(); result = result * 31 - 7;
              if (mode == 0) continue outer;
              if (mode == 1) break inner;
              if (mode == 2) break outer;
              if (mode == 4) return result;
            } finally {
              Effects.cleanup(++cleanups, cleanupAt);
            }
            result = Effects.next(result, ++step, throwAt, 200);
          }
          result = Effects.next(result, ++step, throwAt, 300);
        }
        return result;
      }
    }`;
    const effects = `class Effects {
      static StringBuilder trace;
      static Throwable failed;
      static void mark() { trace.append('C'); }
      static int next(int result, int step, int throwAt, int kind) {
        trace.append(step).append(':').append(kind).append(',');
        if (step == throwAt) { failed = new IllegalArgumentException(); throw (IllegalArgumentException) failed; }
        return result * 31 + kind;
      }
      static void cleanup(int count, int cleanupAt) {
        trace.append('F').append(count).append(',');
        if (count == cleanupAt) { failed = new AssertionError(); throw (AssertionError) failed; }
      }
    }`;
    const driver = `class FinallyLoopRunner { public static void main(String[] args) {
      for (int mode = 0; mode < 6; mode++) for (int throwAt = -1; throwAt <= 12; throwAt++)
        for (int cleanupAt = -1; cleanupAt <= 9; cleanupAt++) {
          Effects.trace = new StringBuilder(); Effects.failed = null; String result;
          try { result = "" + FinallyLoopExits.compute(mode, throwAt, cleanupAt); }
          catch (Throwable error) { result = error.getClass().getSimpleName()+":"+(error == Effects.failed); }
          System.out.println(mode+":"+throwAt+":"+cleanupAt+":"+result+":"+Effects.trace);
        }
    } }`;
    const names = ['FinallyLoopExits', 'Effects', 'FinallyLoopRunner'];
    const native = path.join(temporary, 'native');
    fs.mkdirSync(native);
    for (const [name, source] of Object.entries({FinallyLoopExits: original, Effects: effects,
      FinallyLoopRunner: driver})) fs.writeFileSync(path.join(native, name + '.java'), source);
    run('javac', ['--release', '8', '-d', native,
      ...names.map(name => path.join(native, name + '.java'))], native);
    const expected = run('java', ['-cp', native, 'FinallyLoopRunner'], native);
    assert.equal(expected.trim().split('\n').length, 924);
    assert.match(expected, /AssertionError:true/);
    assert.match(expected, /IllegalArgumentException:true/);
    assert.doesNotMatch(expected, /:false:/);
    for (const forced of [false, true]) {
      if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
      else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const diagnostics = [];
      const source = decompileClassFile(path.join(native, 'FinallyLoopExits.class'), {diagnostics});
      assertNoFallback(source);
      assert.equal(source.includes('switch (statePc)'), forced, JSON.stringify(diagnostics));
      const rebuilt = path.join(temporary, forced ? 'forced' : 'structured');
      fs.mkdirSync(rebuilt);
      for (const [name, text] of Object.entries({FinallyLoopExits: source, Effects: effects,
        FinallyLoopRunner: driver})) fs.writeFileSync(path.join(rebuilt, name + '.java'), text);
      run('javac', ['--release', '8', '-d', rebuilt,
        ...names.map(name => path.join(rebuilt, name + '.java'))], rebuilt);
      const actual = run('java', ['-cp', rebuilt, 'FinallyLoopRunner'], rebuilt);
      if (process.env.CFR_JS_EXCEPTION_LOOP_DIAGNOSTICS) {
        const directory = process.env.CFR_JS_EXCEPTION_LOOP_DIAGNOSTICS;
        fs.mkdirSync(directory, {recursive: true});
        fs.writeFileSync(path.join(directory, forced ? 'finally-forced.java' : 'finally-structured.java'), source);
        fs.writeFileSync(path.join(directory, 'finally-native.txt'), expected);
        fs.writeFileSync(path.join(directory, forced ? 'finally-forced.txt' : 'finally-structured.txt'), actual);
      }
      const expectedLines = expected.trim().split('\n'), actualLines = actual.trim().split('\n');
      assert.equal(actualLines.length, expectedLines.length);
      expectedLines.forEach((line, index) => assert.equal(actualLines[index], line,
        `${forced ? 'forced' : 'structured'} cleanup scenario ${index}: ${JSON.stringify(diagnostics)}`));
    }
  } finally {
    if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('try and catch exits preserve nested-loop destinations and effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-exception-loop-exits-'));
  const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const original = `public class ExceptionLoopExits {
      public static int compute(int mode, int throwAt) {
        int result = 0, step = 0;
        outer: for (int i = 0; i < 4; i++) {
          int j = 0;
          inner: while (j++ < 3) {
            try {
              result = Effects.next(result, ++step, throwAt, i * 10 + j);
              switch (mode) {
                case 0: continue;
                case 1: continue outer;
                case 2: break outer;
                case 3: if (j == 2) break inner; else continue;
                default: result = Effects.next(result, ++step, throwAt, 100);
              }
            } catch (IllegalArgumentException error) {
              result = result * 31 - 7;
              switch (mode) {
                case 0: continue;
                case 1: continue outer;
                case 2: break outer;
                case 3: break inner;
                default: result = result * 31 - 8;
              }
            }
            // An exception here must escape, not enter the preceding catch.
            result = Effects.next(result, ++step, throwAt, 200);
          }
          result = Effects.next(result, ++step, throwAt, 300);
        }
        return result;
      }
    }`;
    const effects = `class Effects {
      static StringBuilder trace;
      static int next(int result, int step, int throwAt, int kind) {
        trace.append(step).append(':').append(kind).append(',');
        if (step == throwAt) throw new IllegalArgumentException();
        return result * 31 + kind;
      }
    }`;
    const driver = `class LoopExitRunner { public static void main(String[] args) {
      for (int mode = 0; mode < 6; mode++) for (int throwAt = -1; throwAt <= 40; throwAt++) {
        Effects.trace = new StringBuilder();
        String result;
        try { result = "" + ExceptionLoopExits.compute(mode, throwAt); }
        catch (Throwable error) { result = error.getClass().getSimpleName(); }
        System.out.println(mode+":"+throwAt+":"+result+":"+Effects.trace);
      }
    } }`;
    const native = path.join(temporary, 'native');
    fs.mkdirSync(native);
    for (const [name, source] of Object.entries({ExceptionLoopExits: original, Effects: effects,
      LoopExitRunner: driver})) fs.writeFileSync(path.join(native, name + '.java'), source);
    run('javac', ['--release', '8', '-d', native, ...['ExceptionLoopExits', 'Effects', 'LoopExitRunner']
      .map(name => path.join(native, name + '.java'))], native);
    const expected = run('java', ['-cp', native, 'LoopExitRunner'], native);
    assert.equal(expected.trim().split('\n').length, 252);
    assert.match(expected, /IllegalArgumentException/);
    for (const forced of [false, true]) {
      if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
      else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const diagnostics = [];
      const source = decompileClassFile(path.join(native, 'ExceptionLoopExits.class'), {diagnostics});
      assertNoFallback(source);
      assert.equal(source.includes('switch (statePc)'), forced, JSON.stringify(diagnostics));
      assert.match(source, /catch \(/);
      const rebuilt = path.join(temporary, forced ? 'forced' : 'structured');
      fs.mkdirSync(rebuilt);
      for (const [name, text] of Object.entries({ExceptionLoopExits: source, Effects: effects,
        LoopExitRunner: driver})) fs.writeFileSync(path.join(rebuilt, name + '.java'), text);
      run('javac', ['--release', '8', '-d', rebuilt,
        ...['ExceptionLoopExits', 'Effects', 'LoopExitRunner']
          .map(name => path.join(rebuilt, name + '.java'))], rebuilt);
      assert.equal(run('java', ['-cp', rebuilt, 'LoopExitRunner'], rebuilt), expected);
    }
  } finally {
    if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('ordered catch arms preserve inner and outer exits and uncaught exception effects', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-ordered-catch-loop-exits-'));
  const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const original = `public class OrderedCatchLoopExits {
      public static int compute(int mode, int throwAt, int errorKind) {
        int result = 0, step = 0;
        outer: for (int i = 0; i < 4; i++) {
          inner: for (int j = 0; j < 3; j++) {
            try {
              result = Effects.next(result, ++step, throwAt, errorKind, i * 10 + j);
              switch (mode) {
                case 0: continue inner;
                case 1: continue outer;
                case 2: break inner;
                default: result = result * 31 + 100;
              }
            } catch (IllegalArgumentException error) {
              Effects.mark('A'); result = result * 31 - 7;
              switch (mode) {
                case 0: continue outer;
                case 1: break inner;
                case 2: break outer;
                default: result = result * 31 - 8;
              }
            } catch (RuntimeException error) {
              Effects.mark('R'); result = result * 31 - 9;
              switch (mode) {
                case 0: continue inner;
                case 1: continue outer;
                case 2: break inner;
                default: break outer;
              }
            }
            // Neither sibling catch protects this call.
            result = Effects.next(result, ++step, throwAt, errorKind, 200);
          }
          result = Effects.next(result, ++step, throwAt, errorKind, 300);
        }
        return result;
      }
    }`;
    const effects = `class Effects {
      static StringBuilder trace;
      static Throwable failed;
      static boolean same(Throwable error) { return error == failed; }
      @SuppressWarnings("unchecked")
      static <T extends Throwable> RuntimeException raise(Throwable error) throws T { throw (T) error; }
      static void mark(char kind) { trace.append(kind); }
      static int next(int result, int step, int throwAt, int errorKind, int kind) {
        trace.append(step).append(':').append(kind).append(',');
        if (step == throwAt) {
          if (errorKind == 0) failed = new IllegalArgumentException();
          else if (errorKind == 1) failed = new IllegalStateException();
          else if (errorKind == 2) failed = new AssertionError();
          else failed = new java.io.IOException();
          throw Effects.<RuntimeException>raise(failed);
        }
        return result * 31 + kind;
      }
    }`;
    const driver = `class OrderedCatchRunner { public static void main(String[] args) {
      for (int mode = 0; mode < 4; mode++) for (int throwAt = -1; throwAt <= 25; throwAt++)
        for (int errorKind = 0; errorKind < 4; errorKind++) {
          Effects.trace = new StringBuilder(); Effects.failed = null; String result;
          try { result = "" + OrderedCatchLoopExits.compute(mode, throwAt, errorKind); }
          catch (Throwable error) { result = error.getClass().getSimpleName()+":"+Effects.same(error); }
          System.out.println(mode+":"+throwAt+":"+errorKind+":"+result+":"+Effects.trace);
        }
    } }`;
    const native = path.join(temporary, 'native');
    fs.mkdirSync(native);
    const names = ['OrderedCatchLoopExits', 'Effects', 'OrderedCatchRunner'];
    for (const [name, source] of Object.entries({OrderedCatchLoopExits: original, Effects: effects,
      OrderedCatchRunner: driver})) fs.writeFileSync(path.join(native, name + '.java'), source);
    run('javac', ['--release', '8', '-d', native,
      ...names.map(name => path.join(native, name + '.java'))], native);
    const expected = run('java', ['-cp', native, 'OrderedCatchRunner'], native);
    assert.equal(expected.trim().split('\n').length, 432);
    assert.match(expected, /AssertionError/);
    assert.match(expected, /IllegalArgumentException/);
    assert.match(expected, /IllegalStateException/);
    assert.match(expected, /IOException:true/);
    assert.doesNotMatch(expected, /:false:/);
    assert.match(expected, /,A/);
    assert.match(expected, /,R/);
    for (const forced of [false, true]) {
      if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
      else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const diagnostics = [];
      const source = decompileClassFile(path.join(native, 'OrderedCatchLoopExits.class'), {diagnostics});
      assertNoFallback(source);
      assert.equal(source.includes('switch (statePc)'), forced, JSON.stringify(diagnostics));
      const rebuilt = path.join(temporary, forced ? 'forced' : 'structured');
      fs.mkdirSync(rebuilt);
      for (const [name, text] of Object.entries({OrderedCatchLoopExits: source, Effects: effects,
        OrderedCatchRunner: driver})) fs.writeFileSync(path.join(rebuilt, name + '.java'), text);
      run('javac', ['--release', '8', '-d', rebuilt,
        ...names.map(name => path.join(rebuilt, name + '.java'))], rebuilt);
      const actual = run('java', ['-cp', rebuilt, 'OrderedCatchRunner'], rebuilt);
      if (process.env.CFR_JS_EXCEPTION_LOOP_DIAGNOSTICS) {
        const directory = process.env.CFR_JS_EXCEPTION_LOOP_DIAGNOSTICS;
        fs.mkdirSync(directory, {recursive: true});
        fs.writeFileSync(path.join(directory, forced ? 'forced.java' : 'structured.java'), source);
        fs.writeFileSync(path.join(directory, 'native.txt'), expected);
        fs.writeFileSync(path.join(directory, forced ? 'forced.txt' : 'structured.txt'), actual);
      }
      const expectedLines = expected.trim().split('\n'), actualLines = actual.trim().split('\n');
      assert.equal(actualLines.length, expectedLines.length);
      expectedLines.forEach((line, index) => assert.equal(actualLines[index], line,
        `${forced ? 'forced' : 'structured'} scenario ${index}`));
    }
  } finally {
    if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});


test('for recovery proves all backedges and preserves protected updates', () => {
  const {rewriteWhileLoopsAsFor, rewriteWhileAsFor} = require('../src/decompiler/cfr')._internals;
  const lines = body => ['i = 0;', 'L: while (i < limit) {', ...body, '}'];
  for (const body of [
    ['  if (skip()) {', '    i++;', '    continue L;', '  }', '  try {', '    close(i);', '    i++;', '  } catch (IOException e) {', '    i++;', '  }'],
    ['  if (skip()) {', '    i++;', '    continue L;', '  }', '  work();'],
    ['  try {', '    i++;', '    continue L;', '  } finally {', '    observe(i);', '  }'],
    ['  synchronized (lock) {', '    i++;', '    continue L;', '  }'],
    ['  if (skip()) {', '    i++;', '    continue L;', '  }', '  i += 2;', '  i++;'],
    ['  while (inner()) {', '    i++;', '    continue L;', '  }', '  i++;'],
    ['  int i = 10;', '  i++;'],
    ['  unknown ???;', '  i++;'],
  ]) assert.deepEqual(rewriteWhileLoopsAsFor(lines(body)), lines(body));
  for (const body of [
    ['  work(i);', '  i++;'],
    ['  if (skip()) {', '    i++;', '    continue L;', '  }', '  work(i);', '  i++;'],
    ['  if (skip()) {', '    i++;', '    continue L;', '  } else {', '    i++;', '    continue L;', '  }'],
    ['  while (inner()) {', '    work(i);', '    continue;', '  }', '  i++;'],
    ['  try {', '    work(i);', '  } catch (IOException e) {', '    caught(e);', '  }', '  i++;'],
    ['  if (stop()) {', '    break;', '  }', '  i++;'],
  ]) assert.match(rewriteWhileLoopsAsFor(lines(body)).join('\n'), /for \(i = 0;/);
  const early = ['while (i < limit) {','  if (skip()) {','    continue;','  }','  i++;','}'];
  assert.equal(rewriteWhileAsFor('i = 0;',early),null,'early text structuring cannot add an update to an existing continue');
  assert.match(rewriteWhileAsFor('i = 0;',['while (i < limit) {','  work(i);','  i++;','}']).join('\n'),/for \(i = 0;/);
});

test('protected counter backedges visit every entry and match native failure effects', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cfr-protected-counter-'));
  const previous=process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const native=path.join(temporary,'native');fs.mkdirSync(native);
    const assembly=`.version 49 0
    .class public super ProtectedCounter
    .super java/lang/Object
    .method public static visit : (IIII)I
      .code stack 3 locals 6
      .catch java/io/IOException from Lwork to LworkEnd using Lcatch
      iconst_0
      istore 4
    Lhead:
      iload 4
      iload_0
      if_icmpge Ldone
      iload_1
      iconst_1
      iload 4
      ishl
      iand
      ifne Lwork
      iinc 4 1
      goto Lhead
    Lwork:
      iload 4
      iload_2
      iload_3
      invokestatic Method CounterEffects close (III)V
    LworkEnd:
      iinc 4 1
      goto Lhead
    Lcatch:
      astore 5
      aload 5
      invokestatic Method CounterEffects caught (Ljava/lang/Throwable;)V
      iinc 4 1
      goto Lhead
    Ldone:
      iload 4
      ireturn
      .end code
    .end method
    .end class`;
    const classFile=path.join(native,'ProtectedCounter.class');assembleJasminSource(assembly,classFile);
    const effects=`class CounterEffects {
      static String trace;static Throwable failure;
      static void close(int index,int throwAt,int kind)throws java.io.IOException {
        trace+="C"+index;if(index!=throwAt || kind==0)return;
        failure=kind==1?new java.io.IOException():kind==2?new IllegalArgumentException():new AssertionError();
        if(kind==1)throw (java.io.IOException)failure;if(kind==2)throw (RuntimeException)failure;throw (Error)failure;
      }
      static void caught(Throwable error){if(error!=failure)throw new AssertionError("caught identity");trace+="H";}
    }`;
    const driver=`class CounterRunner {public static void main(String[] args)throws Exception {
      int cases=0;
      for(int limit:new int[]{-1,0,1,2,5,8})for(int mask:new int[]{0,1,3,42,255})
      for(int throwAt:new int[]{-1,0,1,4,7})for(int kind=0;kind<4;kind++) {
        CounterEffects.trace="";CounterEffects.failure=null;String outcome;
        try{outcome=""+ProtectedCounter.visit(limit,mask,throwAt,kind);}
        catch(RuntimeException|Error error){if(error!=CounterEffects.failure)throw new AssertionError("escaping identity");outcome=error.getClass().getSimpleName();}
        String expected="";boolean fails=false;
        for(int i=0;i<limit;i++)if((mask&(1<<i))!=0){expected+="C"+i;if(i==throwAt&&kind!=0){if(kind==1)expected+="H";else{fails=true;break;}}}
        if(!CounterEffects.trace.equals(expected))throw new AssertionError("visited entries: "+CounterEffects.trace+" != "+expected);
        if(!fails&&!outcome.equals(""+Math.max(0,limit)))throw new AssertionError("final counter");
        System.out.println(limit+":"+mask+":"+throwAt+":"+kind+":"+outcome+":"+CounterEffects.trace);cases++;
      }
      if(cases!=600)throw new AssertionError("coverage");System.out.println("counter-complete:"+cases);
    }} `;
    for(const [name,text] of Object.entries({CounterEffects:effects,CounterRunner:driver}))fs.writeFileSync(path.join(native,name+'.java'),text);
    run('javac',['--release','8','-cp',native,'-d',native,...['CounterEffects','CounterRunner'].map(name=>path.join(native,name+'.java'))],native);
    const expected=run('java',['-cp',native,'CounterRunner'],native);assert.match(expected,/counter-complete:600\n$/);
    for(const forced of [false,true]) {
      if(forced)process.env.CFR_JS_FORCE_STATE_MACHINE='1';else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const source=decompileClassFile(classFile);assertNoFallback(source);
      assert.equal(source.includes('switch (statePc)'),forced);
      const rebuilt=path.join(temporary,forced?'forced':'structured');fs.mkdirSync(rebuilt);
      for(const [name,text] of Object.entries({ProtectedCounter:source,CounterEffects:effects,CounterRunner:driver}))fs.writeFileSync(path.join(rebuilt,name+'.java'),text);
      run('javac',['--release','8','-d',rebuilt,...['ProtectedCounter','CounterEffects','CounterRunner'].map(name=>path.join(rebuilt,name+'.java'))],rebuilt);
      assert.equal(run('java',['-cp',rebuilt,'CounterRunner'],rebuilt),expected);
    }
  } finally {
    if(previous===undefined)delete process.env.CFR_JS_FORCE_STATE_MACHINE;else process.env.CFR_JS_FORCE_STATE_MACHINE=previous;
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
