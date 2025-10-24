const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/convert_tree');
const { parseKrak2Assembly } = require('../src/parse_krak2.js');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast.js');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const assemblerMode = (process.env.ROUNDTRIP_ASSEMBLER || 'classAst').toLowerCase();
const supportedAssemblerModes = new Set(['classast', 'krak2']);
if (!supportedAssemblerModes.has(assemblerMode)) {
  throw new Error(
    `Unsupported ROUNDTRIP_ASSEMBLER value "${process.env.ROUNDTRIP_ASSEMBLER}". ` +
    'Supported values are: classAst, krak2.'
  );
}

const sourcesDir = path.join(__dirname, '../sources');
const krakatauPath = path.resolve(
  __dirname,
  '../tools/krakatau/Krakatau/target/release/krak2'
);
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
    const regeneratedClassFilePath = path.join(tempDir, `${className}.regenerated.class`);

    try {
      // 1. Generate .j file from original .class file
      const classFileContent = fs.readFileSync(classFilePath);
      const originalAst = getAST(new Uint8Array(classFileContent));
      const convertedOriginalAst = convertJson(originalAst.ast, originalAst.constantPool);
      const jContent = unparseDataStructures(convertedOriginalAst.classes[0], originalAst.constantPool);
      fs.writeFileSync(jFilePath, jContent);
      t.pass('.j file generated successfully');

      // Path A: .j -> .class -> classAST (golden)
      execFileSync(krakatauPath, ['asm', jFilePath, '--out', tempClassFilePath]);
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

      // Path C: classAST -> .class -> classAST (roundtrip check)
      if (assemblerMode === 'krak2') {
        execFileSync(krakatauPath, ['asm', jFilePath, '--out', regeneratedClassFilePath]);
        t.pass('Regenerated class using Krakatau assembler');
      } else {
        writeClassAstToClassFile(newClassAst, regeneratedClassFilePath);
        t.pass('Regenerated class using classAstToClassFile assembler');
      }
      const regeneratedClassContent = fs.readFileSync(regeneratedClassFilePath);
      const regeneratedAst = getAST(new Uint8Array(regeneratedClassContent));
      const regeneratedConverted = convertJson(regeneratedAst.ast, regeneratedAst.constantPool);
      const strippedRegenerated = stripCpIndex(deepClone(regeneratedConverted));
      t.deepEqual(strippedRegenerated, newClassAst, 'Reconstructed class from AST should match the original AST');

    } catch (error) {
      t.fail(`Roundtrip test failed with an error: ${error.message}\n${error.stack}`);
    } finally {
      // Cleanup temporary files
      if (fs.existsSync(jFilePath)) fs.unlinkSync(jFilePath);
      if (fs.existsSync(tempClassFilePath)) fs.unlinkSync(tempClassFilePath);
      if (fs.existsSync(regeneratedClassFilePath)) fs.unlinkSync(regeneratedClassFilePath);
      t.end();
    }
  });
});
