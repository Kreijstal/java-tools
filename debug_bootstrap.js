const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson } = require('./src/convert_tree');

const classFilePath = path.join(__dirname, 'sources/ReflectiveArrayTest.class');

try {
  const classFileContent = fs.readFileSync(classFilePath);
  const originalAst = getAST(new Uint8Array(classFileContent));
  const convertedAst = convertJson(originalAst.ast, originalAst.constantPool);
  
  console.log('Looking at converted bootstrap methods...');
  if (convertedAst.classes[0].bootstrapMethods) {
    convertedAst.classes[0].bootstrapMethods.forEach((bsm, index) => {
      console.log(`\nBootstrap Method ${index}:`);
      console.log('  method_ref:', JSON.stringify(bsm.method_ref, null, 2));
      console.log('  arguments:', bsm.arguments.map((arg, argIndex) => {
        console.log(`    [${argIndex}] type:${typeof arg.value}, value:`, JSON.stringify(arg.value));
        return arg.value;
      }));
      if (index >= 2) return; // Just show first few
    });
  }
  
} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
}