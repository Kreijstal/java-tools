const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('./src/convert_tree');

const classFilePath = path.join(__dirname, 'sources/ReflectiveArrayTest.class');

try {
  const classFileContent = fs.readFileSync(classFilePath);
  const originalAst = getAST(new Uint8Array(classFileContent));
  console.log('Looking for InvokeDynamic entries...');
  
  // Find InvokeDynamic entries in constant pool
  originalAst.constantPool.forEach((entry, index) => {
    if (entry && entry.tag === 18) { // InvokeDynamic
      console.log(`\nInvokeDynamic at index ${index}:`, JSON.stringify(entry, null, 2));
    }
  });
  
  // Look at bootstrap methods
  console.log('\nLooking for bootstrap methods...');
  const attrs = originalAst.ast.attributes;
  attrs.forEach((attr, index) => {
    if (attr.attribute_name_index && originalAst.constantPool[attr.attribute_name_index.index - 1]?.info?.bytes === 'BootstrapMethods') {
      console.log(`\nBootstrapMethods attribute:`, JSON.stringify(attr, null, 2));
    }
  });
  
} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
}