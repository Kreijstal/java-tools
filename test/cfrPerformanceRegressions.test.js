'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile, _internals } = require('../src/decompiler/cfr');

const SHARED_EXIT_GUARD_JASMIN = `.version 52 0
.class public super SharedExitGuard
.super java/lang/Object

.field static a Ljava/lang/Object;
.field static b Ljava/lang/Object;
.field static c Ljava/lang/Object;
.field static d Ljava/lang/Object;
.field static e Ljava/lang/Object;
.field static f Ljava/lang/Object;
.field static g Ljava/lang/Object;
.field static h Ljava/lang/Object;

.method public static ready : ()Z
    .code stack 2 locals 0
L0: aconst_null
L1: getstatic Field SharedExitGuard a Ljava/lang/Object;
L2: if_acmpeq Lfalse
L3: aconst_null
L4: getstatic Field SharedExitGuard b Ljava/lang/Object;
L5: if_acmpeq Lfalse
L6: aconst_null
L7: getstatic Field SharedExitGuard c Ljava/lang/Object;
L8: if_acmpeq Lfalse
L9: aconst_null
L10: getstatic Field SharedExitGuard d Ljava/lang/Object;
L11: if_acmpeq Lfalse
L12: aconst_null
L13: getstatic Field SharedExitGuard e Ljava/lang/Object;
L14: if_acmpeq Lfalse
L15: aconst_null
L16: getstatic Field SharedExitGuard f Ljava/lang/Object;
L17: if_acmpeq Lfalse
L18: aconst_null
L19: getstatic Field SharedExitGuard g Ljava/lang/Object;
L20: if_acmpeq Lfalse
L21: aconst_null
L22: getstatic Field SharedExitGuard h Ljava/lang/Object;
L23: if_acmpeq Lfalse
L24: iconst_1
L25: goto Lreturn
Lfalse: iconst_0
Lreturn: ireturn
    .end code
.end method
.end class
`;

test('shared-exit guard ladders use the linear CFG structurer', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-shared-exit-'));
  try {
    const classPath = path.join(tempDir, 'SharedExitGuard.class');
    assembleJasminSource(SHARED_EXIT_GUARD_JASMIN, classPath);
    const source = decompileClassFile(classPath);

    t.ok(_internals.hasHighConditionalTargetFanIn([
      ...Array.from({ length: 6 }, () => ({ instruction: { op: 'ifeq', arg: 'Lfalse' } })),
    ]), 'six conditional edges to one target select the CFG structurer');
    t.notOk(/^\s*\/\/\s*(?:if|goto)\b/m.test(source),
      'the shared-exit ladder decompiles without raw control-flow fallback');
    t.match(source, /static boolean ready\(\)/,
      'the optimized path emits the original method');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});
