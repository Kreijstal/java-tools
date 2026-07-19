'use strict';

// Regressions for three silent-miscompile defects in the exception-handling
// side of the decompiler (fixed in a657e2d). Every one of them kept the build
// green and javac at zero errors while changing what the emitted program does
// at runtime, so they are only detectable by asserting on the emitted source.
//
//   1. normalizeStructuredCatchNodes widened javac-unprovable checked catches
//      to java.lang.Exception and dropped every sibling handler but the first.
//   2. dropRethrowHandlerRows removed every catch-and-rethrow exception-table
//      row, including rows whose only purpose is to shield a later, broader
//      row (the `catch (ThreadDeath t) { throw t; }` before `catch (Throwable)`
//      idiom).
//   3. removeImpossibleCheckedCatchBlocks read resolveMethodThrows returning []
//      as proof of no-throw, but [] also means "could not resolve", and the
//      exception model indexes only corpus classes -- so every JDK callee
//      looked throw-free and its handler was deleted.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile, _internals: cfrInternals } = require('../src/decompiler/cfr');

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function decompileFixture(tempDir, name, source) {
  const classPath = path.join(tempDir, `${name}.class`);
  assembleJasminSource(source, classPath);
  return decompileClassFile(classPath);
}

// Two checked handlers over one protected range whose types no call in the
// range declares -- the obfuscator's undeclared-throw idiom. javac cannot prove
// either is reachable, which is what used to trigger the widening.
//
// The third row exists only to steer strategy selection: a checked handler
// whose body is `astore; goto` makes tableHasTrivialCheckedHandler true, which
// is what routes this method to the owned structurer (and therefore through
// normalizeStructuredCatchNodes) instead of a pattern recognizer.
const CATCH_WIDENING_JASMIN = `.version 52 0
.class public super WidenTest
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0: aload_0
L1: invokespecial Method java/lang/Object <init> ()V
L4: return
    .end code
.end method

.method public work : ()V
    .code stack 1 locals 1
L0: return
    .end code
.end method

.method public recoverA : ()V
    .code stack 1 locals 1
L0: return
    .end code
.end method

.method public recoverB : ()V
    .code stack 1 locals 1
L0: return
    .end code
.end method

.method public run : ()V
    .code stack 3 locals 3
        .catch java/io/IOException from Lstart to Lafter using Lh1
        .catch java/lang/InterruptedException from Lstart to Lafter using Lh2
        .catch java/text/ParseException from Ltriv to Ltrivend using Ltrivh
Lstart: aload_0
Ls1: invokevirtual Method WidenTest work ()V
Lafter: goto Ltriv
Lh1: astore_1
Lh1a: aload_0
Lh1b: invokevirtual Method WidenTest recoverA ()V
Lh1c: goto Lend
Lh2: astore_1
Lh2a: aload_0
Lh2b: invokevirtual Method WidenTest recoverB ()V
Lh2c: goto Lend
Ltriv: aload_0
Lt1: invokevirtual Method WidenTest work ()V
Ltrivend: goto Lend
Ltrivh: astore_2
Lt2: goto Lend
Lend: return
    .end code
.end method
.end class
`;

test('CFR-JS keeps the precise type of a javac-unprovable checked catch', (t) => {
  t.plan(4);
  withTempDir('cfr-catch-widening-', (tempDir) => {
    const source = decompileFixture(tempDir, 'WidenTest', CATCH_WIDENING_JASMIN);

    // Widening over-catches: a `catch (Exception)` swallows every
    // RuntimeException the original method let propagate.
    t.notOk(/catch \(\s*(?:java\.lang\.)?Exception\b/.test(source),
      'an unprovable checked catch is not widened to java.lang.Exception');
    t.match(source, /catch \(\s*(?:java\.io\.)?IOException\b/,
      'the first handler keeps its declared IOException type');
    t.match(source, /catch \(\s*(?:java\.lang\.)?InterruptedException\b/,
      'the sibling handler keeps its declared InterruptedException type');
    // Collapsing the group to unsupported[0] used to delete this body outright.
    t.match(source, /this\.recoverB\(\)/,
      'the sibling handler body survives instead of being discarded');
  });
});

// `catch (ThreadDeath t) { throw t; }` immediately before a `catch (Throwable)`
// over the same range. The rethrow is a semantic no-op in isolation, but the
// row shields the broader row: table rows are searched in order, so dropping it
// reroutes ThreadDeath into the Throwable handler that must never see it.
//
// buildShieldFixture emits the identical method for both catch types so the two
// assertions below differ in exactly one token, which is the whole point: a
// strictly broader later row must keep the rethrow row, an equal-typed later
// row (the obfuscator wrapper this pass exists to strip) must still drop it.
function buildShieldFixture(rethrowCatchType) {
  return `.version 52 0
.class public super ShieldTest
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0: aload_0
L1: invokespecial Method java/lang/Object <init> ()V
L4: return
    .end code
.end method

.method public work : ()V
    .code stack 1 locals 1
L0: return
    .end code
.end method

.method public run : ()V
    .code stack 3 locals 3
        .catch ${rethrowCatchType} from Lstart to Lafter using Lrethrow
        .catch java/lang/Throwable from Lstart to Lafter using Lbroad
        .catch java/io/IOException from Ltrivial to Ltrivend using Ltrivh
Lstart: aload_0
Ls1: invokevirtual Method ShieldTest work ()V
Lafter: goto Lend
Lrethrow: astore_2
Lr1: aload_2
Lr2: athrow
Lbroad: astore_2
Lb1: aload_0
Lb2: invokevirtual Method ShieldTest work ()V
Lb3: goto Lend
Ltrivial: aload_0
Lt1: invokevirtual Method ShieldTest work ()V
Ltrivend: goto Lend
Ltrivh: astore_2
Lt2: goto Lend
Lend: return
    .end code
.end method
.end class
`;
}

// The emitted dispatch may render either as a source-level `catch (ThreadDeath
// ...)` or, when the structurer falls back to a state machine, as an
// `instanceof ThreadDeath` selector. Both mean the row survived; a bare
// `ThreadDeath var = null;` declaration does not, which is exactly what the
// pre-fix output emitted.
const THREAD_DEATH_DISPATCH =
  /catch \(\s*(?:java\.lang\.)?ThreadDeath\b|instanceof\s+(?:java\.lang\.)?ThreadDeath\b/;

test('CFR-JS keeps a catch-and-rethrow row that shields a broader later row', (t) => {
  t.plan(2);
  withTempDir('cfr-rethrow-shield-', (tempDir) => {
    const source = decompileFixture(tempDir, 'ShieldTest',
      buildShieldFixture('java/lang/ThreadDeath'));

    t.match(source, THREAD_DEATH_DISPATCH,
      'ThreadDeath is still dispatched away from the broad Throwable handler');
    t.match(source, /catch \(\s*(?:java\.lang\.)?Throwable\b/,
      'the broad handler it shields is still emitted');
  });
});

test('CFR-JS still drops a same-type catch-and-rethrow wrapper row', (t) => {
  t.plan(2);
  withTempDir('cfr-rethrow-wrapper-', (tempDir) => {
    // Identical bytecode, but the rethrow row now catches the same type as the
    // later row, so it shields nothing and is a pure obfuscator wrapper.
    const source = decompileFixture(tempDir, 'ShieldTest',
      buildShieldFixture('java/lang/Throwable'));

    t.notOk(/instanceof\s+(?:java\.lang\.)?Throwable\b/.test(source),
      'a wrapper row that shields nothing contributes no dispatch arm');
    t.notOk(/\$cfr\$sneakyThrow/.test(source),
      'the wrapper rethrow is not re-emitted as a duplicate handler');
  });
});

test('the unthrowable-checked-catch DCE treats an unresolvable callee as possibly-throwing', (t) => {
  const previous = process.env.PIPELINE_EXPERIMENTAL_UNTHROWABLE_CATCH_DCE;
  process.env.PIPELINE_EXPERIMENTAL_UNTHROWABLE_CATCH_DCE = '1';

  // ck.<init>: `new MediaTracker(...).waitForAll()` really does throw
  // InterruptedException, but java.awt.MediaTracker is outside the corpus, so
  // resolveMethodThrows answers [] and the handler used to be deleted -- after
  // which javac rejected the file with "unreported exception".
  const unresolvableCallee = [
    'try {',
    '    tracker.waitForAll();',
    '} catch (InterruptedException ignored) {',
    '}',
  ];
  const unresolvableCalleeCode = {
    codeItems: [{
      pc: 12,
      instruction: { op: 'invokevirtual', arg: ['Method', 'java/awt/MediaTracker', ['waitForAll', '()V']] },
    }],
    exceptionTable: [{
      start_pc: 8, end_pc: 16, handler_pc: 20,
      catch_type: 'java/lang/InterruptedException',
    }],
  };

  // The exception table routes to a checked type no instruction in the range
  // declares -- the obfuscator's undeclared-throw idiom, which
  // ensureCheckedCatchReachability vouches for. The two passes must not reach
  // opposite conclusions about the same row. The catch is rendered fully
  // qualified here on purpose: the unattributable-type set is keyed by simple
  // name, so a raw Set.has() on "java.io.IOException" silently never matches.
  const qualifiedUnattributable = [
    'try {',
    '    this.count = 1;',
    '} catch (java.io.IOException ignored) {',
    '}',
  ];
  const qualifiedUnattributableCode = {
    codeItems: [
      { pc: 4, instruction: { op: 'iconst_1' } },
      { pc: 5, instruction: { op: 'putfield', arg: ['Field', 'Demo', ['count', 'I']] } },
    ],
    exceptionTable: [{
      start_pc: 4, end_pc: 8, handler_pc: 12,
      catch_type: 'java/io/IOException',
    }],
  };

  // Positive direction: with no exception table at all there is nothing to
  // vouch for the handler, so the pass must still delete it. Without this the
  // fix could be "repaired" in future by disabling the pass outright.
  const genuinelyImpossible = [
    'try {',
    '    int value = 1;',
    '} catch (IOException ignored) {',
    '    value = 2;',
    '}',
  ];

  cfrInternals.removeImpossibleCheckedCatchBlocks(unresolvableCallee, undefined, unresolvableCalleeCode);
  cfrInternals.removeImpossibleCheckedCatchBlocks(qualifiedUnattributable, undefined, qualifiedUnattributableCode);
  cfrInternals.removeImpossibleCheckedCatchBlocks(genuinelyImpossible);

  t.match(unresolvableCallee.join('\n'), /catch \(InterruptedException ignored\)/,
    'a catch around an unresolvable JDK callee is not deleted on silence');
  t.match(qualifiedUnattributable.join('\n'), /catch \(java\.io\.IOException ignored\)/,
    'a fully qualified unattributable catch type is matched by simple name');
  t.deepEqual(genuinelyImpossible, ['{', '    int value = 1;', '}'],
    'a genuinely impossible checked catch is still eliminated');

  if (previous === undefined) delete process.env.PIPELINE_EXPERIMENTAL_UNTHROWABLE_CATCH_DCE;
  else process.env.PIPELINE_EXPERIMENTAL_UNTHROWABLE_CATCH_DCE = previous;
  t.end();
});
