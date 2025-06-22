const { loadClassByPath } = require('../src/classLoader');

function showAST(classFilePath) {
  const classData = loadClassByPath(classFilePath);
  if (!classData) {
    console.error(`Failed to load class from file: ${classFilePath}`);
    process.exit(1);
  }
  console.log(JSON.stringify(classData, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/showAST.js <classFilePath>');
    process.exit(1);
  }

  const classFilePath = args[0];
  showAST(classFilePath);
}

main();