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
