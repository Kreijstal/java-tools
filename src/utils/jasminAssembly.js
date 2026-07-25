'use strict';

const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../parsing/convert_tree');
const { parseKrak2Assembly } = require('../parsing/parse_krak2');
const { convertKrak2AstToClassAst } = require('../parsing/convert_krak2_ast');
const { writeClassAstToClassFile } = require('../parsing/classAstToClassFile');

function parseJasminSource(sourceText) {
  return convertKrak2AstToClassAst(parseKrak2Assembly(sourceText), {
    sourceText,
  });
}

function assembleJasminSource(sourceText, outputClassPath, options = {}) {
  const classAst = parseJasminSource(sourceText);
  writeClassAstToClassFile(classAst, outputClassPath, options);
  return outputClassPath;
}

function assembleJasminFile(inputPath, outputClassPath = null, options = {}) {
  const sourceText = fs.readFileSync(inputPath, 'utf8');
  const targetPath = outputClassPath || defaultClassOutputPath(inputPath);
  return assembleJasminSource(sourceText, targetPath, options);
}

function defaultClassOutputPath(inputPath) {
  const dirname = path.dirname(inputPath);
  const basename = path.basename(inputPath, path.extname(inputPath));
  return path.join(dirname, `${basename}.class`);
}

function parseClassFile(classFilePath) {
  const classBytes = fs.readFileSync(classFilePath);
  const parsed = getAST(new Uint8Array(classBytes));
  const astRoot = convertJson(parsed.ast, parsed.constantPool);
  return {
    astRoot,
    constantPool: parsed.constantPool,
    parsed,
  };
}

function disassembleClassFile(classFilePath, options = {}) {
  const { astRoot, constantPool } = parseClassFile(classFilePath);
  const chunks = (astRoot.classes || []).map((cls) =>
    unparseDataStructures(cls, constantPool, options),
  );
  return chunks.join('\n');
}

function assembleJasminFixture(jasminDir, tempDir, jasminFile, options = {}) {
  const inputPath = path.join(jasminDir, jasminFile);
  const className = path.basename(jasminFile, '.j');
  const outputPath = path.join(tempDir, `${className}.class`);
  assembleJasminFile(inputPath, outputPath, options);
  return outputPath;
}

module.exports = {
  parseJasminSource,
  assembleJasminSource,
  assembleJasminFile,
  assembleJasminFixture,
  parseClassFile,
  disassembleClassFile,
};
