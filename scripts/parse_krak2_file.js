const fs = require('fs');
const path = require('path');
const { parseKrak2Assembly } = require('../src/parse_krak2');

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/parse_krak2_file.js <krak2_assembly_file>');
    process.exit(1);
  }

  const filePath = args[0];
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found at ${filePath}`);
    process.exit(1);
  }

  const assemblyCode = fs.readFileSync(filePath, 'utf-8');
  const ast = parseKrak2Assembly(assemblyCode);

  console.log(JSON.stringify(ast, null, 2));
}

main();
