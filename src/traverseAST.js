const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson } = require('./convert_tree');
const { parseDescriptor } = require('./typeParser');

// Path to the compiled Hello.class file
const classFilePath = path.join(__dirname, '../sources/Hello.class');

// Read the binary content of the class file
const classFileContent = fs.readFileSync(classFilePath);

// Get the AST of the class file
const ast = getAST(new Uint8Array(classFileContent));

const convertedAst = convertJson(ast.ast, ast.constantPool);

function traverseAST(ast) {
  ast.classes.forEach((cls) => {
    console.log(`Class reference found: ${cls.className}`);
    cls.items.forEach((item) => {
      if (item.type === "method") {
        const methodName = item.method.name;
        console.log(`Method reference found: ${methodName}`);
        const descriptorAST = parseDescriptor(item.method.descriptor);
        const referencedClasses = Array.isArray(descriptorAST)
          ? descriptorAST
          : [...descriptorAST.params, descriptorAST.returnType];
        referencedClasses
          .filter(referencedClass => typeof referencedClass === 'string' && referencedClass.includes('/'))
          .forEach(referencedClass => {
            console.log(`Type found in method descriptor: ${referencedClass}`);
          });

        item.method.attributes.forEach((attr) => {
          if (attr.type === "code") {
            attr.code.codeItems.forEach((codeItem) => {
              if (codeItem.instruction && codeItem.instruction.arg) {
                const arg = codeItem.instruction.arg;
                if (Array.isArray(arg) && arg.length > 1) {
                  const className = arg[1];
                  console.log(`Class reference found in instruction: ${className}`);
                }
                if (Array.isArray(arg) && arg.length > 2) {
                  const descriptor = arg[2][1];
                  const descriptorAST = parseDescriptor(descriptor);
                  const referencedClasses = Array.isArray(descriptorAST)
                    ? descriptorAST
                    : [...descriptorAST.params, descriptorAST.returnType];
                  referencedClasses
                    .filter(referencedClass => typeof referencedClass === 'string' && referencedClass.includes('/'))
                    .forEach(referencedClass => {
                      console.log(`Type found in instruction descriptor: ${referencedClass}`);
                    });
                }
              }
            });
          }
        });
      }
    });
  });
}

console.log("Converted AST:", JSON.stringify(convertedAst, null, 2));
console.log("Traversing AST for references:");
traverseAST(convertedAst);
