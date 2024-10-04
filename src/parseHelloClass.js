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

function parseDescriptor(descriptor) {
  const regex = /L([^;]+);/g;
  const matches = [];
  let match;
  while ((match = regex.exec(descriptor)) !== null) {
    matches.push(match[1].replace(/\./g, "/"));
  }
  return matches;
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
                    if (typeof part === 'string' && part.includes('/')) {
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
console.log("Reference Map:", JSON.stringify(referenceMap, null, 2));

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
        const part = instruction.arg[partIndex];
        console.log(`In ${context}, instruction at index ${index}, part ${partIndex} references class:`, part);
      }
    }
  });
});

// Find and attempt to load all class references with context
const classReferencesWithContext = findClassReferencesWithContext(convertedAst);
classReferencesWithContext.forEach(({ className, context }) => {
  console.log(`In ${context}, attempt to load class ${className}`);
  loadClass(className);
});
