const { loadAndTraverse } = require('../src/loadAndTraverse');

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    console.error('Usage: node runLoadAndTraverse.js <classFilePath> [classPath]');
    process.exit(1);
  }

  const classFilePath = args[0];
  const classPath = args[1] || '.';
  loadAndTraverse(classFilePath, classPath);
}

main();
