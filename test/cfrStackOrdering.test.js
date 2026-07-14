'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile } = require('../src/decompiler/cfr');

const POST_INCREMENT_ARRAY_STORE = `.version 52 0
.class public super PostIncrementArrayStore
.super java/lang/Object

.method public static fill : ([BIB)V
    .code stack 3 locals 3
L0: aload_0
L1: iload_1
L2: iinc 1 1
L5: iload_2
L6: bastore
L7: return
    .end code
.end method
.end class
`;

test('iinc snapshots operand-stack values loaded before the increment', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-stack-order-'));
  try {
    const classFile = path.join(tempDir, 'PostIncrementArrayStore.class');
    assembleJasminSource(POST_INCREMENT_ARRAY_STORE, classFile);
    const source = decompileClassFile(classFile);

    t.match(source, /int incrementValue\$\d+ = param1;\s*param1\+\+;\s*param0\[incrementValue\$\d+\] = param2;/,
      'array index uses the value captured before iinc');
    t.notOk(/param1\+\+;\s*param0\[param1\]/.test(source),
      'array store does not reread the incremented local');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});
