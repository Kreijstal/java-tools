'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const frontend = require('../src/java-frontend');
const { disassembleClassFile } = require('../src/utils/jasminAssembly');

const HELLO_WORLD_SOURCE = `
public class Hello {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
`;

function hasJavaCommand() {
  try {
    execFileSync('java', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

test('minimal Java frontend compiler emits runnable Hello World bytecode', (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-frontend-hello-'));
  try {
    const result = frontend.compileJavaSource(HELLO_WORLD_SOURCE, {
      outputDir,
      sourceFileName: 'Hello.java',
    });
    const helloClass = path.join(outputDir, 'Hello.class');

    t.equal(result.schema, frontend.COMPILE_RESULT_SCHEMA_ID, 'compile result has the expected schema');
    t.equal(result.bytecodeIr.schema, frontend.BYTECODE_IR_SCHEMA_ID, 'bytecode IR sidecar is produced');
    t.equal(result.classFileModel.schema, frontend.CLASSFILE_MODEL_SCHEMA_ID, 'classfile model sidecar is produced');
    t.equal(result.classes[0].internalName, 'Hello', 'compiled class has the expected internal name');
    t.ok(fs.existsSync(helloClass), 'Hello.class is written');

    const disassembly = disassembleClassFile(helloClass);
    t.ok(disassembly.includes('getstatic Field java/lang/System out Ljava/io/PrintStream;'), 'compiled bytecode loads System.out');
    t.ok(disassembly.includes('ldc "Hello, World!"'), 'compiled bytecode loads the string literal');
    t.ok(disassembly.includes('invokevirtual Method java/io/PrintStream println (Ljava/lang/String;)V'), 'compiled bytecode calls PrintStream.println(String)');

    if (hasJavaCommand()) {
      const output = execFileSync('java', ['-cp', outputDir, 'Hello'], { encoding: 'utf8' }).trim();
      t.equal(output, 'Hello, World!', 'compiled class runs on a JVM');
    } else {
      t.comment('java command is unavailable; bytecode emission assertions were still checked');
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  t.end();
});

test('JavaFrontend.compile compiles an AST document and preserves serializable models', (t) => {
  const document = frontend.parseJava(HELLO_WORLD_SOURCE, { sourceLevel: 8 });
  const instance = new frontend.JavaFrontend({ sourceLevel: 8 });
  const result = instance.compile(document, { sourceFileName: 'Hello.java' });

  t.equal(result.bytecodeIr.classes.length, 1, 'one class IR is emitted');
  t.equal(result.bytecodeIr.classes[0].methods[1].name, 'main', 'main method is emitted after the default constructor');
  t.doesNotThrow(() => JSON.stringify(result.bytecodeIr), 'bytecode IR is JSON-serializable');
  t.doesNotThrow(() => JSON.stringify(result.classFileModel), 'classfile model is JSON-serializable');
  t.end();
});

test('expected pass pipeline emits minimal bytecode and classfile sidecars', (t) => {
  const document = frontend.parseJava(HELLO_WORLD_SOURCE, { sourceLevel: 8 });
  const passes = frontend.createFullFrontendPassPipeline();
  const result = new frontend.JavaAstPassManager({ passes }).runWithResult(document, {
    include: ['frontend.validateClassFileModel'],
  });

  t.ok(result.document.meta.javaFrontendBytecodeIr, 'bytecode IR sidecar exists');
  t.equal(result.document.meta.javaFrontendBytecodeIr.classes[0].internalName, 'Hello', 'bytecode IR contains Hello');
  t.ok(result.document.meta.javaFrontendClassFileModel, 'classfile model sidecar exists');
  t.ok(result.document.meta.javaFrontendClassFileModel.classes[0].jasmin.includes('println'), 'classfile model contains Jasmin for println');
  t.ok(frontend.getNodeAnnotation(result.document.root, 'frontend.validateClassFileModel.status'), 'validation status annotation is recorded');
  t.end();
});
