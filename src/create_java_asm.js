/**
 * Java Class Disassembler - Converts Java .class files to assembly-like format
 * This script parses Java bytecode files and converts them to human-readable assembly syntax
 * for analysis and debugging purposes.
 */

const fs = require('fs');
const path = require('path');
const { getAST: getAstOriginal, opcodeNames } = require('jvm_parser');
const { unparseDataStructures, convertJson } = require('./convert_tree');
const { parseWideInstruction } = require('./wide_parser');

function getAST(classFileContent) {
    const ast = getAstOriginal(classFileContent);
    for (const classData of ast.ast.classes) {
        for (const method of classData.methods) {
            for (const attribute of method.attributes) {
                if (attribute.info.code) {
                    const bytecode = attribute.info.code.code;
                    const newInstructions = [];
                    let offset = 0;
                    while (offset < bytecode.length) {
                        const wideInstruction = parseWideInstruction(bytecode, offset);
                        if (wideInstruction) {
                            newInstructions.push(wideInstruction.instruction);
                            offset += wideInstruction.length;
                        } else {
                            const { InstructionParser } = require('jvm_parser/parsers');
                            const instruction = InstructionParser.parse(bytecode.slice(offset));
                            newInstructions.push(instruction);
                            offset += instruction.info ? instruction.info.length : 1;
                        }
                    }
                    attribute.info.code.instructions = newInstructions;
                }
            }
        }
    }
    return ast;
}

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
  const classFilePath = process.argv[2] || path.join(__dirname, '../sources/Hello.class');
  
  try {
    const asmSyntax = parseClassFile(classFilePath);
    const outputFilePath = classFilePath.replace('.class', '.j');
    fs.writeFileSync(outputFilePath, asmSyntax);
    console.log(`Assembly code written to ${outputFilePath}`);
  } catch (error) {
    console.error('Error parsing class file:', error.message);
    process.exit(1);
  }
}

module.exports = { parseClassFile };
