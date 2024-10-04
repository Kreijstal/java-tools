const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { unparseDataStructures } = require('./convert_tree');

// Path to the compiled Hello.class file
const classFilePath = path.join(__dirname, '../sources/Hello.class');

// Read the binary content of the class file
const classFileContent = fs.readFileSync(classFilePath);

// Get the AST of the class file
const ast = getAST(new Uint8Array(classFileContent));

console.log("AST structure:", JSON.stringify(ast, null, 2));
const asmSyntax = unparseDataStructures(ast);

// Output the ASM syntax
console.log(asmSyntax);
