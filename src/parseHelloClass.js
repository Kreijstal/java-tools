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

// Function to traverse the AST and find class references
function findClassReferences(ast) {
  const classReferences = new Set();

  ast.classes.forEach((cls) => {
    cls.items.forEach((item) => {
      if (item.type === "method") {
        item.method.attributes.forEach((attr) => {
          if (attr.type === "code") {
            attr.code.codeItems.forEach((codeItem) => {
              if (codeItem.instruction && codeItem.instruction.arg) {
                const arg = codeItem.instruction.arg;
                if (Array.isArray(arg) && arg.length > 1) {
                  const className = arg[1];
                  classReferences.add(className);
                }
              }
            });
          }
        });
      }
    });
  });

  return classReferences;
}

// Find and attempt to load all class references
const classReferences = findClassReferences(convertedAst);
classReferences.forEach((className) => {
  loadClass(className);
});
