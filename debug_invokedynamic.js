const fs = require('fs');
const { getAST } = require('jvm_parser');

// Parse StringConcat.class to examine invokedynamic instruction structure
const classFileContent = fs.readFileSync('./sources/StringConcat.class');
const ast = getAST(new Uint8Array(classFileContent));

// Find the main method
const mainMethod = ast.ast.methods.find(m => m.name === 'main');

// Find the invokedynamic instruction
const invokeDynamicInstr = mainMethod.code.instructions.find(instr => instr.opcodeName === 'invokedynamic');

console.log('invokedynamic instruction structure:');
console.log(JSON.stringify(invokeDynamicInstr, null, 2));

console.log('\nConstant pool entry at index', invokeDynamicInstr.operands.index, ':');
console.log(JSON.stringify(ast.constantPool[invokeDynamicInstr.operands.index], null, 2));