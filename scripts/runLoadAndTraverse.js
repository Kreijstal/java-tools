const { loadAndTraverse } = require('../src/loadAndTraverse');

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) {
    console.error('Usage: node runLoadAndTraverse.js <classFilePath> <mainClassName> [classPath]');
    process.exit(1);
  }

  const classFilePath = args[0];
  const mainClassName = args[1];
  const classPath = args[2] || '.';
  loadAndTraverse(classFilePath, classPath, mainClassName);
}

main();
