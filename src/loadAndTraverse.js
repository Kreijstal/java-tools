const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson } = require('./convert_tree');
const { getReferenceObjFromClass } = require('./traverseAST');
const { assembleClasses, runClass } = require('./assembleAndRun');
const { loadClass } = require('./classLoader');
const { renameMethod } = require('./renameMethod');

function loadAndTraverse(className, classPath) {
 
  const convertedAst = loadClass(className,classPath);

  const loadedClasses = new Set([className]);
  let referenceObj = {};
  getReferenceObjFromClass(convertedAst, 0, referenceObj);

  Object.keys(referenceObj).forEach(className => {
    if (!loadedClasses.has(className)) {
      let newclass=loadClass(className,classPath);
      if (newclass) {
        convertedAst.classes.push(newclass.classes[0]); //appending
        getReferenceObjFromClass(convertedAst, 1, referenceObj);
        loadedClasses.add(className);
      } else if (!className.startsWith('java/')) {
        console.error(`Failed to load class: ${className}`);
      }
      // Optionally, append the loaded class to convertedAst if needed
    }
  });
  // Example call to renameMethod
  renameMethod(referenceObj, 'TestMethods', 'publicMethod1', 'asfsdsdgre');
  assembleClasses(convertedAst);
  runClass(className);
}

module.exports = { loadAndTraverse };
