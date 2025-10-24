const test = require('tape');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/convert_tree');
const { parseKrak2Assembly } = require('../src/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');

function buildClassAstFromFile(classFilePath) {
  const classFileContent = fs.readFileSync(classFilePath);
  const originalAst = getAST(new Uint8Array(classFileContent));
  const convertedOriginalAst = convertJson(originalAst.ast, originalAst.constantPool);
  const jContent = unparseDataStructures(convertedOriginalAst.classes[0], originalAst.constantPool);
  const krak2Ast = parseKrak2Assembly(jContent);
  return convertKrak2AstToClassAst(krak2Ast);
}

test('assembler preserves exception tables for try/catch blocks', (t) => {
  const compileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ast-ex-compile-'));
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ast-ex-out-'));
  const cleanupPaths = [compileDir, outputDir];

  const className = 'TryCatchSample';
  const javaFilePath = path.join(__dirname, `../sources/${className}.java`);
  const compiledClassPath = path.join(compileDir, `${className}.class`);
  const outputClassPath = path.join(outputDir, `${className}.class`);

  try {
    execFileSync('javac', ['-g', '-d', compileDir, javaFilePath], { stdio: 'inherit' });

    const classAstRoot = buildClassAstFromFile(compiledClassPath);
    const classDef = classAstRoot.classes[0];
    const safeDivideMethod = classDef.items.find(
      (item) => item.type === 'method' && item.method && item.method.name === 'safeDivide'
    );
    t.ok(safeDivideMethod, 'safeDivide method should be present in TryCatchSample');

    const codeAttribute = safeDivideMethod.method.attributes.find((attr) => attr.type === 'code');
    t.ok(codeAttribute, 'safeDivide should include a code attribute');
    t.ok(
      Array.isArray(codeAttribute.code.exceptionTable) && codeAttribute.code.exceptionTable.length > 0,
      'Exception table should be present in the code attribute'
    );

    writeClassAstToClassFile(classAstRoot, outputClassPath);

    const javapVerbose = execFileSync('javap', ['-classpath', outputDir, '-v', className], { encoding: 'utf8' });
    t.ok(javapVerbose.includes('Exception table:'), 'javap output should include an exception table section');
    t.ok(
      javapVerbose.includes('java/lang/ArithmeticException'),
      'javap output should list ArithmeticException handler in the exception table'
    );
  } catch (error) {
    t.fail(`Exception table preservation test failed: ${error.message}`);
  } finally {
    cleanupPaths.forEach((dir) => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    t.end();
  }
});
