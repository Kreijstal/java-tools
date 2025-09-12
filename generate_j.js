const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('./src/convert_tree');

const tempDir = path.join(__dirname, 'test/temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const classFilePath = path.join(__dirname, 'sources/ReflectiveArrayTest.class');
const jFilePath = path.join(tempDir, 'ReflectiveArrayTest.j');

try {
  const classFileContent = fs.readFileSync(classFilePath);
  const originalAst = getAST(new Uint8Array(classFileContent));
  const convertedOriginalAst = convertJson(originalAst.ast, originalAst.constantPool);
  const jContent = unparseDataStructures(convertedOriginalAst.classes[0], originalAst.constantPool);
  fs.writeFileSync(jFilePath, jContent);
  console.log('Generated', jFilePath);
} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
}