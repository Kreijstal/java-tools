const fs = require('fs');
const path = require('path');
const { parseClassFile } = require('../src/create_java_asm');

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/generate_asm.js <classFilePath>');
    process.exit(1);
  }

  const classFilePath = args[0];
  if (!fs.existsSync(classFilePath)) {
    console.error(`Error: File not found at ${classFilePath}`);
    process.exit(1);
  }

  const assembly = parseClassFile(classFilePath);
  console.log(assembly);
}

main();
