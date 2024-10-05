const { loadAndTraverse } = require('../src/loadAndTraverse');
const { loadClass } = require('../src/classLoader');
const { assembleClasses } = require('../src/assembleAndRun');
const { getReferenceObjFromClass } = require('../src/traverseAST');
const { renameMethod } = require('../src/renameMethod');

module.exports.replaceMethod = function replaceMethod(mainClass,className, classPath, oldMethodName, newMethodName,targetPath='.') {
  const {convertedAst,referenceObj} = loadAndTraverse(mainClass, classPath);
  console.log("className",className,classPath)
  //console.log("Loaded AST:", JSON.stringify(convertedAst, null, 2));
  //console.log("Initial Reference Object:", JSON.stringify(referenceObj, null, 2));
  // console.log("Converted AST:", JSON.stringify(convertedAst, null, 2));
  renameMethod(convertedAst, referenceObj, className, oldMethodName, newMethodName);

  assembleClasses(convertedAst,targetPath);
  // console.log("Reference Object after renaming:", JSON.stringify(referenceObj, null, 2));
}

if (require.main === module) {
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
}
