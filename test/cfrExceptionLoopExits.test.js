'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');

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
