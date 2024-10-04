const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson } = require('./convert_tree');

// Path to the compiled Hello.class file
const classFilePath = path.join(__dirname, '../sources/Hello.class');

// Read the binary content of the class file
const classFileContent = fs.readFileSync(classFilePath);

// Get the AST of the class file
const ast = getAST(new Uint8Array(classFileContent));

const convertedAst = convertJson(ast.ast, ast.constantPool);

function traverseAST(node, path = []) {
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'className') {
        console.log(`Class reference found at ${path.join('.')}: ${value}`);
      }
      if (key === 'fieldName') {
        console.log(`Field reference found at ${path.join('.')}: ${value}`);
      }
      if (key === 'methodName') {
        console.log(`Method reference found at ${path.join('.')}: ${value}`);
      }
      traverseAST(value, [...path, key]);
    }
  } else if (Array.isArray(node)) {
    node.forEach((item, index) => {
      traverseAST(item, [...path, index]);
    });
  }
}

console.log("Traversing AST for references:");
traverseAST(convertedAst);
