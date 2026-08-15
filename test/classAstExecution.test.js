const test = require('tape');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/parsing/convert_tree');
const { parseKrak2Assembly } = require('../src/parsing/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/parsing/convert_krak2_ast');
const { writeClassAstToClassFile } = require('../src/parsing/classAstToClassFile');

function buildClassAstFromFile(classFilePath) {
  const classFileContent = fs.readFileSync(classFilePath);
  const originalAst = getAST(new Uint8Array(classFileContent));
  const convertedOriginalAst = convertJson(originalAst.ast, originalAst.constantPool);
  const jContent = unparseDataStructures(convertedOriginalAst.classes[0], originalAst.constantPool);
  const krak2Ast = parseKrak2Assembly(jContent);
  return convertKrak2AstToClassAst(krak2Ast, { sourceText: jContent });
}

test('class AST to class file can be executed', (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ast-exec-'));
  const compileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ast-exec-src-'));
  const cleanupPaths = [outputDir, compileDir];
  const className = 'Hello';
  const javaFilePath = path.join(__dirname, `../sources/${className}.java`);
  const compiledClassPath = path.join(compileDir, `${className}.class`);
  const outputClassPath = path.join(outputDir, `${className}.class`);

  try {
    execFileSync('javac', ['-g', '-d', compileDir, javaFilePath], { stdio: 'inherit' });

    const classAstRoot = buildClassAstFromFile(compiledClassPath);

    writeClassAstToClassFile(classAstRoot, outputClassPath);
    const output = execFileSync('java', ['-cp', outputDir, className], { encoding: 'utf8' });
    t.ok(/Hello, World!/.test(output), 'Executing regenerated class should produce expected output');
  } catch (error) {
    t.fail(`Execution test failed: ${error.message}`);
  } finally {
    cleanupPaths.forEach((dir) => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    t.end();
  }
});

test('class AST writer preserves textual negative double constants', (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ast-double-'));
  const outputClassPath = path.join(outputDir, 'NegativeDouble.class');
  const assembly = `.version 52 0
.class public super NegativeDouble
.super java/lang/Object
.method public static value : ()D
  .code stack 2 locals 0
    ldc2_w -128.0
    dreturn
  .end code
.end method
.end class
`;
  try {
    const classAst = convertKrak2AstToClassAst(
      parseKrak2Assembly(assembly), { sourceText: assembly });
    const method = classAst.classes[0].items.find((item) =>
      item.type === 'method' && item.method.name === 'value');
    const constant = method.method.attributes
      .find((attribute) => attribute.type === 'code').code.codeItems
      .find((item) => item && item.op === 'ldc2_w');
    constant.arg = '-128.0';

    t.doesNotThrow(() => writeClassAstToClassFile(classAst, outputClassPath),
      'a decimal ldc2_w token is assembled as a double rather than a long');
    t.ok(fs.statSync(outputClassPath).size > 0,
      'the class file is emitted');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
    t.end();
  }
});

test('class AST writer accepts Java-suffixed textual long constants', (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ast-long-'));
  const outputClassPath = path.join(outputDir, 'SuffixedLong.class');
  const assembly = `.version 52 0
.class public super SuffixedLong
.super java/lang/Object
.method public static value : ()J
  .code stack 2 locals 0
    ldc2_w 4294967296L
    lreturn
  .end code
.end method
.end class
`;
  try {
    const classAst = convertKrak2AstToClassAst(
      parseKrak2Assembly(assembly), { sourceText: assembly });

    t.doesNotThrow(() => writeClassAstToClassFile(classAst, outputClassPath),
      'an L-suffixed ldc2_w token is normalized before BigInt parsing');
    t.ok(fs.statSync(outputClassPath).size > 0,
      'the class file is emitted');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
    t.end();
  }
});
