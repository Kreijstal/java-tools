'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');

function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const fds = files.map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...fds], timeout: 15000});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally { fds.forEach(fd => fs.closeSync(fd)); }
}

// The builder is live on the operand stack at a branch join. Its prefix cannot
// be recovered from the suffix appended after that join, including in catches.
const assembly = `.version 49 0
.class public super BuilderJoins
.super java/lang/Object
.method public static context : (Ljava/lang/Object;)Ljava/lang/String;
  .code stack 3 locals 1
    new java/lang/StringBuilder
    dup
    invokespecial Method java/lang/StringBuilder <init> ()V
    ldc "prefix:"
    invokevirtual Method java/lang/StringBuilder append (Ljava/lang/String;)Ljava/lang/StringBuilder;
    aload_0
    ifnonnull Lpresent
    ldc "null"
    goto Ljoin
Lpresent:
    ldc "present"
Ljoin:
    invokevirtual Method java/lang/StringBuilder append (Ljava/lang/String;)Ljava/lang/StringBuilder;
    invokevirtual Method java/lang/StringBuilder toString ()Ljava/lang/String;
    areturn
  .end code
.end method
.method public static fromExisting : (Ljava/lang/StringBuilder;Ljava/lang/String;)Ljava/lang/String;
  .code stack 2 locals 2
    aload_0
    aload_1
    invokevirtual Method java/lang/StringBuilder append (Ljava/lang/String;)Ljava/lang/StringBuilder;
    invokevirtual Method java/lang/StringBuilder toString ()Ljava/lang/String;
    areturn
  .end code
.end method
.method public static caught : (Ljava/lang/Object;)Ljava/lang/String;
  .code stack 3 locals 2
    .catch java/lang/RuntimeException from Ltry to Lend using Lcatch
Ltry:
    aconst_null
    athrow
Lend:
Lcatch:
    astore_1
    new java/lang/StringBuilder
    dup
    invokespecial Method java/lang/StringBuilder <init> ()V
    ldc "failure("
    invokevirtual Method java/lang/StringBuilder append (Ljava/lang/String;)Ljava/lang/StringBuilder;
    aload_0
    ifnonnull Lobject
    ldc "null"
    goto LcatchJoin
Lobject:
    ldc "{...}"
LcatchJoin:
    invokevirtual Method java/lang/StringBuilder append (Ljava/lang/String;)Ljava/lang/StringBuilder;
    bipush 41
    invokevirtual Method java/lang/StringBuilder append (C)Ljava/lang/StringBuilder;
    invokevirtual Method java/lang/StringBuilder toString ()Ljava/lang/String;
    areturn
  .end code
.end method
.end class`;
const driver = `class BuilderRunner { public static void main(String[] args) {
  for (Object marker : new Object[]{null, new Object()}) {
    System.out.println(BuilderJoins.context(marker));
    System.out.println(BuilderJoins.caught(marker));
  }
  StringBuilder builder = new StringBuilder("seed");
  System.out.println(BuilderJoins.fromExisting(builder,"A"));
  System.out.println(BuilderJoins.fromExisting(builder,"B"));
  System.out.println(builder.toString());
} }`;

for (const forced of [false, true]) test(`builder prefixes and mutations survive joins and catches: forced=${forced}`, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-builder-joins-'));
  const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const native = path.join(temporary, 'native'); fs.mkdirSync(native);
    const classFile = path.join(native, 'BuilderJoins.class');
    // The fixture assembler normalizes literal operands on labeled code items.
    let instruction = 0;
    assembleJasminSource(assembly.replace(/^    ([a-z].*)$/gm,
      (_, body) => `Linst${instruction++}: ${body}`), classFile);
    const driverFile = path.join(temporary, 'BuilderRunner.java'); fs.writeFileSync(driverFile, driver);
    run('javac', ['--release', '8', '-cp', native, '-d', native, driverFile], native);
    const expected = run('java', ['-cp', native, 'BuilderRunner'], native);
    assert.equal(expected, 'prefix:null\nfailure(null)\nprefix:present\nfailure({...})\nseedA\nseedAB\nseedAB\n');
    if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
    else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    const source = decompileClassFile(classFile, {forceOwnedStructurer: true});
    assertNoFallback(source);
    const rebuilt = path.join(temporary, 'rebuilt'); fs.mkdirSync(rebuilt);
    const javaFile = path.join(rebuilt, 'BuilderJoins.java'); fs.writeFileSync(javaFile, source);
    run('javac', ['--release', '8', '-d', rebuilt, javaFile, driverFile], rebuilt);
    assert.equal(run('java', ['-cp', rebuilt, 'BuilderRunner'], rebuilt), expected);
  } finally {
    if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
