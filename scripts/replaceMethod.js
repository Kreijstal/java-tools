const { loadAndTraverse } = require('../src/loadAndTraverse');
const { renameMethod } = require('../src/renameMethod');

function replaceMethod(className, classPath, oldMethodName, newMethodName) {
  const convertedAst = loadAndTraverse(className, classPath);
  let referenceObj = {};
  renameMethod(convertedAst, referenceObj, className, oldMethodName, newMethodName);
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
