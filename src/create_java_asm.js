/**
 * Java Class Disassembler - Converts Java .class files to assembly-like format
 * This script parses Java bytecode files and converts them to human-readable assembly syntax
 * for analysis and debugging purposes.
 */

const fs = require('fs');
const path = require('path');
const { getAST, opcodeNames } = require('jvm_parser');
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
  const convertedAst = convertJson(ast.ast, ast.constantPool, opcodeNames);
  const asmSyntax = unparseDataStructures(convertedAst.classes[0]);
  
  return asmSyntax;
}

// Default behavior: parse Hello.class if run directly
if (require.main === module) {
  // Path to the compiled Hello.class file
  const classFilePath = path.join(__dirname, '../sources/Hello.class');
  
  try {
    const asmSyntax = parseClassFile(classFilePath);
    console.log(asmSyntax);
  } catch (error) {
    console.error('Error parsing class file:', error.message);
    process.exit(1);
  }
}

module.exports = { parseClassFile };
