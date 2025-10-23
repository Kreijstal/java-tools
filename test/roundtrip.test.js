const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/convert_tree');
const { parseKrak2Assembly } = require('../src/parse_krak2.js');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast.js');

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const sourcesDir = path.join(__dirname, '../sources');
const classNames = fs
  .readdirSync(sourcesDir)
  .filter((fileName) => fileName.endsWith('.class'))
  .map((fileName) => fileName.slice(0, -'.class'.length))
  .sort((a, b) => a.localeCompare(b));

classNames.forEach(className => {
  test(`Roundtrip test for ${className}.class`, (t) => {
    const classFilePath = path.join(__dirname, `../sources/${className}.class`);
    const jFilePath = path.join(tempDir, `${className}.j`);
    const tempClassFilePath = path.join(tempDir, `${className}.class`);

    try {
      // 1. Generate .j file from original .class file
      const classFileContent = fs.readFileSync(classFilePath);
      const originalAst = getAST(new Uint8Array(classFileContent));
      const convertedOriginalAst = convertJson(originalAst.ast, originalAst.constantPool);
      const jContent = unparseDataStructures(convertedOriginalAst.classes[0], originalAst.constantPool);
      fs.writeFileSync(jFilePath, jContent);
      t.pass('.j file generated successfully');

      // Path A: .j -> .class -> classAST (golden)
      const krak2Path = path.resolve(__dirname, '../tools/krakatau/Krakatau/target/release/krak2');
      execFileSync(krak2Path, ['asm', jFilePath, '--out', tempClassFilePath]);
      const goldenClassFileContent = fs.readFileSync(tempClassFilePath);
      const goldenAst = getAST(new Uint8Array(goldenClassFileContent));
      const goldenClassAst = convertJson(goldenAst.ast, goldenAst.constantPool);

      function deepClone(value) {
        if (value === null || typeof value !== 'object') {
          return value;
        }

        if (Array.isArray(value)) {
          return value.map(deepClone);
        }

        const clone = {};
        for (const key of Object.keys(value)) {
          clone[key] = deepClone(value[key]);
        }
        return clone;
      }

      function stripCpIndex(obj) {
        if (obj && typeof obj === 'object') {
          for (const key in obj) {
            if (key === 'cp_index' || key === 'pc') {
              delete obj[key];
            } else {
              stripCpIndex(obj[key]);
            }
          }
        }
        return obj;
      }

      const strippedGoldenAst = stripCpIndex(deepClone(goldenClassAst));
      t.pass('Golden classAST generated and stripped successfully');

      // Path B: .j -> krak2AST -> classAST (new)
      const krak2Ast = parseKrak2Assembly(jContent);
      const newClassAst = convertKrak2AstToClassAst(krak2Ast);
      t.pass('New classAST generated successfully');

      // Verification
      t.deepEqual(newClassAst, strippedGoldenAst, "The AST from the new parser should match the golden AST");

    } catch (error) {
      t.fail(`Roundtrip test failed with an error: ${error.message}\n${error.stack}`);
    } finally {
      // Cleanup temporary files
      if (fs.existsSync(jFilePath)) fs.unlinkSync(jFilePath);
      if (fs.existsSync(tempClassFilePath)) fs.unlinkSync(tempClassFilePath);
      t.end();
    }
  });
});
