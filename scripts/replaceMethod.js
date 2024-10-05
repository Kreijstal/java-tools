const { loadAndTraverse } = require('../src/loadAndTraverse');
const { renameMethod } = require('../src/renameMethod');

function replaceMethod(className, classPath, oldMethodName, newMethodName) {
  const convertedAst = loadAndTraverse(className, classPath);
  let referenceObj = {};
  console.log("Converted AST:", JSON.stringify(convertedAst, null, 2));
  console.log("Reference Object before renaming:", JSON.stringify(referenceObj, null, 2));
  renameMethod(convertedAst, referenceObj, className, oldMethodName, newMethodName);
  console.log("Reference Object after renaming:", JSON.stringify(referenceObj, null, 2));
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
