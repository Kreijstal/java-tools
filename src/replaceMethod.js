const { loadAndTraverse } = require('../src/loadAndTraverse');
const { loadClass } = require('../src/classLoader');
const { assembleClasses } = require('../src/assembleAndRun');
const { getReferenceObjFromClass } = require('../src/traverseAST');
const { renameMethod } = require('../src/renameMethod');

function replaceMethod(mainClass,className, classPath, oldMethodName, newMethodName,targetPath='.') {
  console.log("b4 traverse")
  const {convertedAst,referenceObj} = loadAndTraverse(mainClass, classPath);
  console.log("className",className,classPath)
  //console.log("Loaded AST:", JSON.stringify(convertedAst, null, 2));
  //console.log("Initial Reference Object:", JSON.stringify(referenceObj, null, 2));
  // console.log("Converted AST:", JSON.stringify(convertedAst, null, 2));
  console.log("calling rename method")
  renameMethod(convertedAst, referenceObj, className, oldMethodName, newMethodName);

  assembleClasses(convertedAst,targetPath);
  // console.log("Reference Object after renaming:", JSON.stringify(referenceObj, null, 2));
}
module.exports.replaceMethod =replaceMethod;
if (require.main === module) {
  function main() {
    const args = process.argv.slice(2);
    if (args.length !== 6) {
      console.error('Usage: node replaceMethod.js <mainClass> <className> <classPath> <oldMethodName> <newMethodName> <targetPath>');
      process.exit(1);
    }

    const [mainClass, className, classPath, oldMethodName, newMethodName, targetPath] = args;
    console.log("first")
    replaceMethod(mainClass, className, classPath, oldMethodName, newMethodName, targetPath);
  }

  main();
}
