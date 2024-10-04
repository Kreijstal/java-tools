const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson } = require('./convert_tree');
const { parseDescriptor } = require('./typeParser');
const { Reference } = require('./referenceInterface');

// Path to the compiled Hello.class file
const nativeTypes = new Set(["byte", "char", "double", "float", "int", "long", "short", "boolean", "void"]);

function getReferenceObjFromClass(convertedAst, classIndex,referenceObj, addSelfRefs = false) {
  traverseAST(convertedAst, classIndex,referenceObj);

  if (addSelfRefs) {
    addSelfReferences(referenceObj);
  }

  return referenceObj;
}

function addDescriptorReferences(referenceObj) {
  Object.keys(referenceObj).forEach(className => {
    const classObj = referenceObj[className];
    Object.entries(classObj.children).forEach(([childName, child]) => {
      const descriptor = child.descriptor;
      const descriptorAST = parseDescriptor(descriptor);

      // Check if the descriptor is a method descriptor
      if (descriptorAST.params) {
        descriptorAST.params.forEach(paramType => {
          if (!nativeTypes.has(paramType) && referenceObj[paramType]) {
            referenceObj[paramType].referees.push(`${className}.children.${childName}.descriptor`);
          }
        });
        if (!nativeTypes.has(descriptorAST.returnType) && referenceObj[descriptorAST.returnType]) {
          referenceObj[descriptorAST.returnType].referees.push(`refobj.${className}.children.${childName}.descriptor`);
        }
      } else {
        // It's a field descriptor
        descriptorAST.forEach(type => {
          if (!nativeTypes.has(type) && referenceObj[type]) {
            referenceObj[type].referees.push(`${className}.children.${childName}.descriptor`);
          }
        });
      }
    });
  });
}

function addSelfReferences(referenceObj) {
  const nativeTypes = new Set(["byte", "char", "double", "float", "int", "long", "short", "boolean", "void"]);
  Object.keys(referenceObj).forEach(className => {
    const classObj = referenceObj[className];
    Object.entries(classObj.children).forEach(([childName, child]) => {
      const descriptor = child.descriptor;
      const descriptorAST = parseDescriptor(descriptor);

      // Check if the descriptor is a method descriptor
      if (descriptorAST.params) {
        descriptorAST.params.forEach(paramType => {
          if (!nativeTypes.has(paramType) && !referenceObj[paramType]) {
            referenceObj[paramType] = { children: {}, referees: [] };
          }
          referenceObj[paramType].referees.push(`refobj.${className}.children.${childName}.descriptor`);
        });
        if (!nativeTypes.has(descriptorAST.returnType)) {
          if (!referenceObj[descriptorAST.returnType]) {
            referenceObj[descriptorAST.returnType] = { children: {}, referees: [] };
          }
          referenceObj[descriptorAST.returnType].referees.push(`${className}.children.${childName}.descriptor`);
        }
      } else {
        // It's a field descriptor
        descriptorAST.forEach(type => {
          if (!nativeTypes.has(type) && !referenceObj[type]) {
            referenceObj[type] = { children: {}, referees: [] };
          }
          referenceObj[type].referees.push(`refobj.${className}.children.${childName}.descriptor`);
        });
      }
    });
  });
}
function traverseAST(convertedAst, classIndex,referenceObj) {
  //console.log("convertedAst",convertedAst,classIndex)
  const cls = convertedAst.classes[classIndex];

  ((cls, classIndex) => {
      if (!referenceObj[cls.className]) {
        if (!referenceObj[cls.className]) {
          referenceObj[cls.className] = { children: {}, referees: [] };
        }
      }
      referenceObj[cls.className].referees.push(`classes.${classIndex}`);

      cls.items.forEach((item, itemIndex) => {
        if (item.type === "method") {
          const methodName = item.method.name;
          const methodDescriptor = item.method.descriptor;
          if (!referenceObj[cls.className].children[methodName]) {
            referenceObj[cls.className].children[methodName] = {
              descriptor: methodDescriptor,
              referees: []
            };
          }
          referenceObj[cls.className].children[methodName].referees.push(`classes.${classIndex}.items.${itemIndex}.method`);

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
                    if (!referenceObj[parentClass].children[fieldNameOrMethodName]) {
                      referenceObj[parentClass].children[fieldNameOrMethodName] = {
                        descriptor: descriptor,
                        referees: []
                      };
                    }
                    referenceObj[parentClass].children[fieldNameOrMethodName].referees.push(`classes.${classIndex}.items.${itemIndex}.method.attributes.${attrIndex}.code.codeItems.${codeItemIndex}`);
                  }
                }
              });
            }
          });
        }
      });
    })(cls,classIndex);

    addDescriptorReferences(referenceObj);
    return referenceObj;
}

function printReferees(referenceObj, debug = false) {
  Object.entries(referenceObj).forEach(([className, classObj]) => {
    console.log(`Class: ${className}`);
    console.log(`  Referees: ${classObj.referees.join(', ')}`);
    Object.entries(classObj.children).forEach(([childName, childObj]) => {
      console.log(`  Child: ${childName}`);
      console.log(`    Descriptor: ${childObj.descriptor}`);
      console.log(`    Referees:`);
      childObj.referees.forEach(refereePath => {
        if (debug) {
          console.log(`      Path: ${refereePath}`);
          const refereeObject = followPath(convertedAst, refereePath);
          console.log(`      Object: ${JSON.stringify(refereeObject, null, 2)}`);
        }
      });
    });
  });
}

function followPath(ast, path) {
  const pathParts = path.split(/\.|\[|\]/).filter(Boolean);
  let current = ast;
  for (const part of pathParts) {
    if (current && typeof current === 'object') {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

module.exports = {
  getReferenceObjFromClass,
  printReferees,
  addSelfReferences
};
