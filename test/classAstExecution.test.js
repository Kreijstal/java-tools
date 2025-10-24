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

function buildClassAst(className) {
  const classFilePath = path.join(__dirname, `../sources/${className}.class`);
  const classFileContent = fs.readFileSync(classFilePath);
  const originalAst = getAST(new Uint8Array(classFileContent));
  const convertedOriginalAst = convertJson(originalAst.ast, originalAst.constantPool);
  const jContent = unparseDataStructures(convertedOriginalAst.classes[0], originalAst.constantPool);
  const krak2Ast = parseKrak2Assembly(jContent);
  return convertKrak2AstToClassAst(krak2Ast);
}

test('class AST to class file can be executed', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ast-exec-'));
  const className = 'Hello';
  const classAstRoot = buildClassAst(className);
  const outputClassPath = path.join(tempDir, `${className}.class`);

  try {
    writeClassAstToClassFile(classAstRoot, outputClassPath);
    const output = execFileSync('java', ['-cp', tempDir, className], { encoding: 'utf8' });
    t.ok(/Hello, World!/.test(output), 'Executing regenerated class should produce expected output');
  } catch (error) {
    t.fail(`Execution test failed: ${error.message}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    t.end();
  }
});
