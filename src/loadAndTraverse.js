const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson } = require('./convert_tree');
const { getReferenceObjFromClass } = require('./traverseAST');
const { loadClass } = require('./classLoader');

function loadAndTraverse(className,classPath) {
 
  const convertedAst = loadClass(className,classPath);

  const loadedClasses = new Set();
  let referenceObj={};
  getReferenceObjFromClass(convertedAst, 0,referenceObj);

  Object.keys(referenceObj).forEach(className => {
    if (!loadedClasses.has(className)) {
      let newclass=loadClass(className,classPath);
      convertedAst.classes.push(newclass.classes[0]);//appending
      loadedClasses.add(className);
      // Optionally, append the loaded class to convertedAst if needed
    }
  });
}

module.exports = { loadAndTraverse };
