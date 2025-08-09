const { parseClassFile, disassemble } = require('./dissasembleClass');
const { ClassFile } = require('./parsers');
const opcodeNames = require('./opcodeNames');

/**
 * Get the disassembled string of a class file.
 * @param {Uint8Array} cafebabe - The binary content of the class file.
 * @returns {string} - The disassembled string.
 */
function getDisassembled(cafebabe) {
    const clazz=parseClassFile(ClassFile.parse(cafebabe),opcodeNames);
    return disassemble(clazz.ast,clazz.constantPool);
}

/**
 * Get the AST form of a class file.
 * @param {Uint8Array} cafebabe - The binary content of the class file.
 * @returns {Object} - The AST representation.
 */
function getAST(cafebabe) {
    return parseClassFile(ClassFile.parse(cafebabe),opcodeNames);
}

/**
 * parse Class and get the struct properties
 * @param {Uint8Array} cafebabe - The binary content of the class file.
 * @returns {Object} - The classfile "struct".
 */
function getClassFileStruct(cafebabe) {
    return ClassFile.parse(cafebabe);
}

module.exports = {
    getDisassembled,
    getAST,
    getClassFileStruct
};
