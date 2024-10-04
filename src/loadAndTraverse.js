const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson } = require('./convert_tree');
const { getReferenceObjFromClass } = require('./traverseAST');
const { loadClass } = require('./classLoader');

function loadAndTraverse(classFilePath) {
  const classFileContent = fs.readFileSync(classFilePath);
  const ast = getAST(new Uint8Array(classFileContent));
  const convertedAst = convertJson(ast.ast, ast.constantPool);

  const loadedClasses = new Set();
  const referenceObj = getReferenceObjFromClass(convertedAst, 0);

  Object.keys(referenceObj).forEach(className => {
    if (!loadedClasses.has(className)) {
      loadClass(className);
      loadedClasses.add(className);
      // Optionally, append the loaded class to convertedAst if needed
    }
  });
}

module.exports = { loadAndTraverse };
