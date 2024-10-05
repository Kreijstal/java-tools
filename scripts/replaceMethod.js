const { loadAndTraverse } = require('../src/loadAndTraverse');
const { loadClass } = require('../src/classLoader');
const { assembleClasses } = require('../src/assembleAndRun');
const { getReferenceObjFromClass } = require('../src/traverseAST');
const { renameMethod } = require('../src/renameMethod');

function replaceMethod(className, classPath, oldMethodName, newMethodName) {
  const convertedAst = loadClass(className, classPath);

  const loadedClasses = new Set([className]);
  let referenceObj = {};
  getReferenceObjFromClass(convertedAst, 0, referenceObj);

  Object.keys(referenceObj).forEach(className => {
    if (!loadedClasses.has(className)) {
      let newclass = loadClass(className, classPath);
      if (newclass) {
        convertedAst.classes.push(newclass.classes[0]); //appending
        getReferenceObjFromClass(convertedAst, 1, referenceObj);
        loadedClasses.add(className);
      } else if (!className.startsWith('java/')) {
        console.error(`Failed to load class: ${className}`);
      }
    }
  });

  assembleClasses(convertedAst);
  // console.log("Converted AST:", JSON.stringify(convertedAst, null, 2));
  // console.log("Reference Object before renaming:", JSON.stringify(referenceObj, null, 2));
  renameMethod(convertedAst, referenceObj, className, oldMethodName, newMethodName);
  // console.log("Reference Object after renaming:", JSON.stringify(referenceObj, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    console.error('Usage: node replaceMethod.js <className> <classPath> <oldMethodName> <newMethodName>');
    process.exit(1);
  }

  const [className, classPath, oldMethodName, newMethodName] = args;
  replaceMethod(className, classPath, oldMethodName, newMethodName);
}

main();
