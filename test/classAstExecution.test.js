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
