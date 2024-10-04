const { loadAndTraverse } = require('../src/loadAndTraverse');

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node runLoadAndTraverse.js <classFilePath>');
    process.exit(1);
  }

  const classFilePath = args[0];
  loadAndTraverse(classFilePath);
}

main();
