const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');

const args = process.argv.slice(2);
let cp = '.';
let className = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-cp' || args[i] === '-classpath') {
    if (i + 1 < args.length) {
      cp = args[i + 1];
      i++;
    } else {
      console.error('Error: classpath not specified');
      process.exit(1);
    }
  } else {
    className = args[i];
  }
}

if (!className) {
  console.error('Usage: node src/getAST.js [-cp <classpath>] <className>');
  process.exit(1);
}

const classpath = cp.split(':');
let classFilePath = null;
const relativePath = `${className.replace(/\./g, '/')}.class`;

for (const p of classpath) {
  const fullPath = path.join(p, relativePath);
  if (fs.existsSync(fullPath)) {
    classFilePath = fullPath;
    break;
  }
}

if (!classFilePath) {
  console.error(`Error: Could not find class ${className} in classpath`);
  process.exit(1);
}

// Read the binary content of the class file
const classFileContent = fs.readFileSync(classFilePath);

// Get the AST of the class file
const ast = getAST(new Uint8Array(classFileContent));

// Output the AST
console.log(JSON.stringify(ast, null, 2));
