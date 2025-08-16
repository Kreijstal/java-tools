const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');

// Get the class file path from the command line arguments
const classFilePath = process.argv[2];

if (!classFilePath) {
  console.error('Usage: node scripts/get_ast_for_file.js <path_to_class_file>');
  process.exit(1);
}

console.log(`Current working directory: ${process.cwd()}`);
console.log(`Attempting to read file from: ${classFilePath}`);
const resolvedPath = path.resolve(classFilePath);
console.log(`Resolved path: ${resolvedPath}`);

if (!fs.existsSync(resolvedPath)) {
  console.error(`File not found at resolved path: ${resolvedPath}`);

  // Also try to list contents of the parent directory
  try {
    const parentDir = path.dirname(resolvedPath);
    console.log(`Listing contents of parent directory: ${parentDir}`);
    const files = fs.readdirSync(parentDir);
    console.log(files);
  } catch (e) {
    console.error(`Could not read parent directory: ${e.message}`);
  }

  process.exit(1);
}

// Read the binary content of the class file
const classFileContent = fs.readFileSync(classFilePath);

// Get the AST of the class file
const ast = getAST(new Uint8Array(classFileContent));

// Output the AST
console.log(JSON.stringify(ast, null, 2));
