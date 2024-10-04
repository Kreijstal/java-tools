const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson } = require('./convert_tree');
const { parseDescriptor } = require('./typeParser');
const { Reference } = require('./referenceInterface');

// Path to the compiled Hello.class file
const classFilePath = path.join(__dirname, '../sources/Hello.class');

// Read the binary content of the class file
const classFileContent = fs.readFileSync(classFilePath);

// Get the AST of the class file
const ast = getAST(new Uint8Array(classFileContent));

const convertedAst = convertJson(ast.ast, ast.constantPool);

function traverseAST(ast) {
  ast.classes.forEach((cls, classIndex) => {
    const classRef = new Reference(cls.className, 'class');
    console.log(`Class reference found at path classes.${classIndex}: ${classRef.name}`);
    cls.items.forEach((item, itemIndex) => {
      if (item.type === "method") {
        const methodName = item.method.name;
        const methodDescriptor = item.method.descriptor;
        const methodRef = new Reference(methodName, 'method', classRef);
        classRef.addChild(methodRef);
        console.log(`Method reference found at path classes.${classIndex}.items.${itemIndex}.method: ${methodRef.name}, Descriptor: ${methodDescriptor}`);
        const descriptorAST = parseDescriptor(item.method.descriptor);
        const referencedClasses = Array.isArray(descriptorAST)
          ? descriptorAST
          : [...descriptorAST.params, descriptorAST.returnType];
        referencedClasses
          .filter(referencedClass => typeof referencedClass === 'string' && referencedClass.includes('/'))
          .forEach(referencedClass => {
            console.log(`Type found in method descriptor at classes.${classIndex}.items.${itemIndex}.method.descriptor: ${referencedClass}`);
          });

        item.method.attributes.forEach((attr, attrIndex) => {
          if (attr.type === "code") {
            attr.code.codeItems.forEach((codeItem, codeItemIndex) => {
              if (codeItem.instruction && codeItem.instruction.arg) {
                const arg = codeItem.instruction.arg;
                if (Array.isArray(arg)) {
                  if (arg.length > 2) {
                    const [fieldNameOrMethodName, descriptor] = arg[2];
                    const fieldOrMethodRef = new Reference(fieldNameOrMethodName, 'fieldOrMethod', methodRef);
                    methodRef.addChild(fieldOrMethodRef);
                    console.log(`Field or method name found in instruction at path classes.${classIndex}.items.${itemIndex}.method.attributes.${attrIndex}.code.codeItems.${codeItemIndex}: ${fieldOrMethodRef.name}, Parent class: ${arg[1]}, Type: ${descriptor}`);
                    const methodDescriptor = arg[2][1];
                    const descriptorAST = parseDescriptor(methodDescriptor);
                    const referencedClasses = Array.isArray(descriptorAST)
                      ? descriptorAST
                      : [...descriptorAST.params, descriptorAST.returnType];
                    referencedClasses
                      .filter(referencedClass => typeof referencedClass === 'string' && referencedClass.includes('/'))
                      .forEach(referencedClass => {
                        console.log(`Type found in instruction descriptor at classes.${classIndex}.items.${itemIndex}.method.attributes.${attrIndex}.code.codeItems.${codeItemIndex}: ${referencedClass}`);
                      });
                  }
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
