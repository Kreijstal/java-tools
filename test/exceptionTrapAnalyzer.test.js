'use strict';

const test = require('tape');
const { analyzeJavap } = require('../src/exceptionTrapAnalyzer');

test('exception trap analyzer detects skipped athrow handler traps', (t) => {
  const javap = `
  final boolean b(int, boolean);
    descriptor: (IZ)Z
    Code:
       939: aconst_null
       940: aload         6
       942: if_acmpne     949
       945: goto          1136
       948: athrow
       949: aload_0
      1136: aload_0
      1137: getfield      #126
      1140: ifne          1222
      Exception table:
         from    to  target type
          939   948   948   Class java/lang/RuntimeException
`;

  const findings = analyzeJavap(javap);
  t.equal(findings.length, 1, 'finds handler athrow');
  t.equal(findings[0].handlerPc, 948, 'records handler pc');
  t.equal(findings[0].trapLike, true, 'classifies branch-skipped handler athrow as trap-like');
  t.end();
});

test('exception trap analyzer does not flag normal branch to athrow as trap-like', (t) => {
  const javap = `
  final void a();
    descriptor: ()V
    Code:
       0: aload_0
       1: ifnonnull     5
       4: athrow
       5: return
      Exception table:
         from    to  target type
            0    4    4   Class java/lang/RuntimeException
`;

  const findings = analyzeJavap(javap);
  t.equal(findings.length, 1, 'finds handler athrow');
  t.equal(findings[0].trapLike, false, 'normal predecessor prevents trap-like classification');
  t.end();
});
