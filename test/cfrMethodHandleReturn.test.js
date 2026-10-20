'use strict';
const test = require('tape');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile} = require('../src/decompiler/cfr');

test('signature-polymorphic MethodHandle calls preserve descriptor return casts', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-method-handle-'));
  try {
    for (const [descriptor, javaType, returnOp] of [['I', 'int', 'ireturn'], ['J', 'long', 'lreturn'],
      ['Ljava/lang/String;', 'String', 'areturn']]) {
      const file = path.join(directory, 'HandleReturn.class');
      assembleJasminSource(`.version 52 0
.class public HandleReturn
.super java/lang/Object
.method public static invoke : (Ljava/lang/invoke/MethodHandle;)${descriptor}
    .code stack 2 locals 1
        aload_0
        invokevirtual Method java/lang/invoke/MethodHandle invokeExact ()${descriptor}
        ${returnOp}
    .end code
.end method
.end class
`, file);
      const source = decompileClassFile(file);
      t.match(source, new RegExp('\\(' + javaType + '\\) [^;]*\\.invokeExact\\('), javaType + ' return cast survives');
    }
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
  t.end();
});
