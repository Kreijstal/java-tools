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

function addDescriptorReferences(referenceObj) {
  Object.keys(referenceObj).forEach(className => {
    const classObj = referenceObj[className];
    Object.entries(classObj.children).forEach(([childName, child]) => {
      const child = classObj.children[childName];
      const descriptor = child.descriptor;
      const descriptorAST = parseDescriptor(descriptor);

      // Check if the descriptor is a method descriptor
      if (descriptorAST.params) {
        descriptorAST.params.forEach(paramType => {
          if (referenceObj[paramType]) {
            referenceObj[paramType].referees.push(`${className}.children.${childName}.descriptor`);
          }
        });
        if (referenceObj[descriptorAST.returnType]) {
          referenceObj[descriptorAST.returnType].referees.push(`${className}.children.${childName}.descriptor`);
        }
      } else {
        // It's a field descriptor
        descriptorAST.forEach(type => {
          if (referenceObj[type]) {
            referenceObj[type].referees.push(`${className}.children.${childName}.descriptor`);
          }
        });
      }
    });
  });
}

function traverseAST(ast) {
  const referenceObj = {};

  ast.classes.forEach((cls, classIndex) => {
    if (!referenceObj[cls.className]) {
      referenceObj[cls.className] = { children: {}, referees: [] };
    }
    referenceObj[cls.className].referees.push(`classes.${classIndex}`);

    cls.items.forEach((item, itemIndex) => {
      if (item.type === "method") {
        const methodName = item.method.name;
        const methodDescriptor = item.method.descriptor;
        referenceObj[cls.className].children[methodName] = {
          descriptor: methodDescriptor,
          referees: [`classes.${classIndex}.items.${itemIndex}.method`]
        };

        item.method.attributes.forEach((attr, attrIndex) => {
          if (attr.type === "code") {
            attr.code.codeItems.forEach((codeItem, codeItemIndex) => {
              if (codeItem.instruction && codeItem.instruction.arg) {
                const arg = codeItem.instruction.arg;
                if (Array.isArray(arg) && arg.length > 2) {
                  const [fieldNameOrMethodName, descriptor] = arg[2];
                  const parentClass = arg[1];

                  if (!referenceObj[parentClass]) {
                    referenceObj[parentClass] = { children: {}, referees: [] };
                  }
                  referenceObj[parentClass].children[fieldNameOrMethodName] = {
                    descriptor: descriptor,
                    referees: [`classes.${classIndex}.items.${itemIndex}.method.attributes.${attrIndex}.code.codeItems.${codeItemIndex}`]
                  };
                }
              }
            });
          }
        });
      }
    });
  });

  addDescriptorReferences(referenceObj);
  console.log("Reference Object after descriptor pass:", JSON.stringify(referenceObj, null, 2));
}

console.log("Traversing AST for references:");
traverseAST(convertedAst);
