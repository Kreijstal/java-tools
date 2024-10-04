const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');

// Path to the compiled Hello.class file
const classFilePath = path.join(__dirname, '../sources/Hello.class');

// Read the binary content of the class file
const classFileContent = fs.readFileSync(classFilePath);

// Get the AST of the class file
const ast = getAST(new Uint8Array(classFileContent));

// Output the AST
console.log(JSON.stringify(ast, null, 2));
