const fs = require('fs');
const path = require('path');
const { parseWideInstruction } = require('./wide_parser');
const { opcodeNames } = require('jvm_parser');
const { unparseDataStructures, convertJson } = require('./convert_tree');

function parseClassFile(classFilePath) {
  const classFileContent = fs.readFileSync(classFilePath);
  const ast = {
    ast: {
      classes: [
        {
          methods: [
            {
              attributes: [
                {
                  info: {
                    code: {
                      code: classFileContent,
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    constantPool: [],
  };

  const bytecode = ast.ast.classes[0].methods[0].attributes[0].info.code.code;
  const newInstructions = [];
  let offset = 0;
  while (offset < bytecode.length) {
    const wideInstruction = parseWideInstruction(bytecode, offset);
    if (wideInstruction) {
      newInstructions.push(wideInstruction.instruction);
      offset += wideInstruction.length;
    } else {
      const opcode = bytecode[offset];
      newInstructions.push({ opcode: opcode, info: {}, length: 1 });
      offset++;
    }
  }
  ast.ast.classes[0].methods[0].attributes[0].info.code.instructions = newInstructions;

  const convertedAst = convertJson(ast.ast, ast.constantPool, opcodeNames);
  const asmSyntax = unparseDataStructures(convertedAst.classes[0]);

  return asmSyntax;
}

if (require.main === module) {
  const classFilePath = process.argv[2];
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
