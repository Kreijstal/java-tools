/**
 * Java Class Disassembler - Converts Java .class files to assembly-like format
 * This script parses Java bytecode files and converts them to human-readable assembly syntax
 * for analysis and debugging purposes.
 */

const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { unparseDataStructures, convertJson } = require('./convert_tree');

/**
 * Parses a Java class file and converts it to assembly-like syntax
 * @param {string} classFilePath - Path to the .class file to parse
 * @returns {string} Assembly-like representation of the class
 */
function parseClassFile(classFilePath) {
  // Read the binary content of the class file
  const classFileContent = fs.readFileSync(classFilePath);
  
  // Get the AST of the class file
  const ast = getAST(new Uint8Array(classFileContent));
  
  // Convert to structured format and then to assembly syntax
  const convertedAst = convertJson(ast.ast, ast.constantPool);
  const asmSyntax = unparseDataStructures(convertedAst.classes[0]);
  
  return asmSyntax;
}

// Default behavior: parse Hello.class if run directly
if (require.main === module) {
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
    console.error('Usage: node src/create_java_asm.js [-cp <classpath>] <className>');
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
  
  try {
    const asmSyntax = parseClassFile(classFilePath);
    console.log(asmSyntax);
  } catch (error) {
    console.error('Error parsing class file:', error.message);
    process.exit(1);
  }
}

module.exports = { parseClassFile };
