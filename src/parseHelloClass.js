const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { unparseDataStructures, convertJson } = require('./convert_tree');
const { loadClass } = require('./classLoader');
const { parseDescriptor } = require('./typeParser');

// Path to the compiled Hello.class file
const classFilePath = path.join(__dirname, '../sources/Hello.class');

// Read the binary content of the class file
const classFileContent = fs.readFileSync(classFilePath);

// Get the AST of the class file
const ast = getAST(new Uint8Array(classFileContent));

const convertedAst = convertJson(ast.ast, ast.constantPool);
/* console.log("Converted AST:", JSON.stringify(convertedAst, null, 2)); */

// Function to traverse the AST and find class references
function findClassReferences(ast) {
  const classReferences = new Set();

  ast.classes.forEach((cls) => {
    cls.items.forEach((item) => {
      if (item.type === "method") {
        item.method.attributes.forEach((attr) => {
          if (attr.type === "code") {
            attr.code.codeItems.forEach((codeItem, index) => {
              if (codeItem.instruction && codeItem.instruction.arg) {
                const arg = codeItem.instruction.arg;
                console.log(`Processing instruction: ${JSON.stringify(codeItem.instruction)}`);
                if (Array.isArray(arg) && arg.length > 1) {
                  const className = arg[1];
                  classReferences.add(className);
                }
                if (Array.isArray(arg) && arg.length > 2) {
                  // Parse method descriptor to include return and parameter types
                  const descriptor = arg[2][1];
                  console.log(`Parsing descriptor: ${descriptor}`);
                  const referencedClasses = parseDescriptor(descriptor);
                  console.log(`Referenced classes from descriptor: ${referencedClasses}`);
                  referencedClasses.forEach((referencedClass) => {
                    if (!referenceMap[referencedClass]) {
                      referenceMap[referencedClass] = [];
                    }
                    referenceMap[referencedClass].push({
                      context: `${className}.${methodName}`,
                      index: index,
                      partIndex: 'descriptor' // Indicate it's from the descriptor
                    });
                  });
                }
              }
            });
            if (!referenceMap[className]) {
              referenceMap[className] = [];
            }
            referenceMap[className].push({
              context,
              index: path[path.length - 1],
              partIndex: 'instruction'
            });
          }
          if (Array.isArray(value.arg) && value.arg.length > 2) {
            const descriptor = value.arg[2][1];
            const descriptorAST = parseDescriptor(descriptor);
            const referencedClasses = Array.isArray(descriptorAST)
              ? descriptorAST
              : [...descriptorAST.params, descriptorAST.returnType];
            referencedClasses
              .filter(referencedClass => typeof referencedClass === 'string' && referencedClass.includes('/'))
              .forEach(referencedClass => {
                console.log(`Type found in instruction at ${path.join('.')}: ${referencedClass}`);
                if (!referenceMap[referencedClass]) {
                  referenceMap[referencedClass] = [];
                }
                referenceMap[referencedClass].push({
                  context,
                  index: path[path.length - 1],
                  partIndex: 'descriptor'
                });
              });
          }
        });
      }
    });
  });

  return classReferences;
}

function findClassReferencesWithContext(ast) {
  const classReferences = [];

  ast.classes.forEach((cls) => {
    cls.items.forEach((item) => {
      if (item.type === "method") {
        const methodName = item.method.name;
        item.method.attributes.forEach((attr) => {
          if (attr.type === "code") {
            attr.code.codeItems.forEach((codeItem, index) => {
              if (codeItem.instruction && codeItem.instruction.arg) {
                const arg = codeItem.instruction.arg;
                if (Array.isArray(arg) && arg.length > 1) {
                  const className = arg[1];
                  classReferences.push({
                    className,
                    context: `${cls.className}.${methodName}`
                  });
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


function buildReferenceMap(ast) {
  const referenceMap = {};

  ast.classes.forEach((cls) => {
    const className = cls.className;

    cls.items.forEach((item) => {
      if (item.type === "method") {
        const methodName = item.method.name;

        item.method.attributes.forEach((attr) => {
          if (attr.type === "code") {
            attr.code.codeItems.forEach((codeItem, index) => {
              if (codeItem.instruction && codeItem.instruction.arg) {
                const arg = codeItem.instruction.arg;
                if (Array.isArray(arg) && arg.length > 1) {
                  const referencedClass = arg[1];
                  console.log(`Found referenced class: ${referencedClass}`);
                  if (!referenceMap[referencedClass]) {
                    referenceMap[referencedClass] = [];
                  }
                  arg.forEach((part, partIndex) => {
                    console.log(`Resolving part: ${part} at index: ${index}, partIndex: ${partIndex}`);
                    if (typeof part === 'string') {
                      // Check if the part is a class reference
                      if (part.includes('/')) {
                        const referencedClass = part;
                        if (!referenceMap[referencedClass]) {
                          referenceMap[referencedClass] = [];
                        }
                        referenceMap[referencedClass].push({
                          context: `${className}.${methodName}`,
                          index: index,
                          partIndex: partIndex // Track which part of the instruction references the class
                        });
                      }
                      // Check if the part is a descriptor
                      const descriptorMatches = parseDescriptor(part);
                      descriptorMatches
                        .filter(descriptorClass => descriptorClass.includes('/'))
                        .forEach((descriptorClass) => {
                          if (!referenceMap[descriptorClass]) {
                            referenceMap[descriptorClass] = [];
                          }
                          referenceMap[descriptorClass].push({
                            context: `${className}.${methodName}`,
                            index: index,
                            partIndex: 'descriptor' // Indicate it's from the descriptor
                          });
                        });
                    }
                  });
                }
              }
            });
          }
        });
      }
    });
  });

  return referenceMap;
}

const referenceMap = buildReferenceMap(convertedAst);

// Iterate over the reference map and print the instruction using context and index
Object.entries(referenceMap).forEach(([referencedClass, references]) => {
  references.forEach(({ context, index, partIndex }) => {
    const [className, methodName] = context.split('.');
    const cls = convertedAst.classes.find(c => c.className === className);
    if (cls) {
      const method = cls.items.find(item => item.type === "method" && item.method.name === methodName);
      if (method) {
        const instruction = method.method.attributes
          .find(attr => attr.type === "code")
          .code.codeItems[index].instruction;
        console.log(`In ${context}, instruction at index ${index}:`, JSON.stringify(instruction, null, 2));
      }
    }
  });
});


const refOrTaggedConstInstructions = [
  "getfield",
  "getstatic",
  "invokedynamic",
  "invokespecial",
  "invokestatic",
  "invokevirtual",
  "putfield",
  "putstatic"
];

const ldcInstructions = ["ldc", "ldc_w", "ldc2_w"];

const newarrayTypes = [
  "boolean",
  "char",
  "float",
  "double",
  "byte",
  "short",
  "int",
  "long"
];

function traverseAndPrintTypes(node, path = [], context = '') {
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'className') {
        console.log(`Type found at ${path.join('.')}: ${value}`);
        if (!referenceMap[value]) {
          referenceMap[value] = [];
        }
        referenceMap[value].push({
          context,
          index: path[path.length - 1],
          partIndex: 'className'
        });
      }
      if (key === 'descriptor') {
        const descriptorAST = parseDescriptor(value);
        const referencedClasses = Array.isArray(descriptorAST)
          ? descriptorAST
          : [...descriptorAST.params, descriptorAST.returnType];
        referencedClasses
          .filter(referencedClass => typeof referencedClass === 'string' && referencedClass.includes('/'))
          .forEach(referencedClass => {
            console.log(`Type found at ${path.join('.')}: ${referencedClass}`);
            if (!referenceMap[referencedClass]) {
              referenceMap[referencedClass] = [];
            }
            referenceMap[referencedClass].push({
              context,
              index: path[path.length - 1],
              partIndex: 'descriptor'
            });
          });
      }
      if (key === 'instruction' && value && value.op) {
        if (refOrTaggedConstInstructions.includes(value.op) || ldcInstructions.includes(value.op)) {
          if (Array.isArray(value.arg) && value.arg.length > 1) {
            const className = value.arg[1];
            console.log(`Type found in instruction at ${path.join('.')}: ${className}`);
          }
          if (Array.isArray(value.arg) && value.arg.length > 2) {
            const descriptor = value.arg[2][1];
            const descriptorAST = parseDescriptor(descriptor);
            const referencedClasses = Array.isArray(descriptorAST)
              ? descriptorAST
              : [...descriptorAST.params, descriptorAST.returnType];
            referencedClasses
              .filter(referencedClass => typeof referencedClass === 'string' && referencedClass.includes('/'))
              .forEach(referencedClass => {
                console.log(`Type found in instruction at ${path.join('.')}: ${referencedClass}`);
              });
          }
        }
      }
      traverseAndPrintTypes(value, [...path, key], context);
    }
  } else if (Array.isArray(node)) {
    node.forEach((item, index) => {
      traverseAndPrintTypes(item, [...path, index], context);
    });
  }
}

console.log("Traversing AST for types:");
traverseAndPrintTypes(convertedAst);

// Find and attempt to load all class references with context
const classReferencesWithContext = findClassReferencesWithContext(convertedAst);
classReferencesWithContext.forEach(({ className, context }) => {
  console.log(`In ${context}, attempt to load class ${className}`);
  loadClass(className);
});
