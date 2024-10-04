const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { unparseDataStructures, convertJson } = require('./convert_tree');
const { loadClass } = require('./classLoader');

// Path to the compiled Hello.class file
const classFilePath = path.join(__dirname, '../sources/Hello.class');

// Read the binary content of the class file
const classFileContent = fs.readFileSync(classFilePath);

// Get the AST of the class file
const ast = getAST(new Uint8Array(classFileContent));

const convertedAst = convertJson(ast.ast, ast.constantPool);
console.log("Converted AST:", JSON.stringify(convertedAst, null, 2));

// Example usage of loadClass
loadClass("java/lang/System");
