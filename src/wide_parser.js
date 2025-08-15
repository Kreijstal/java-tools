function parseWideInstruction(bytecode, offset) {
  const opcode = bytecode[offset];
  if (opcode !== 0xc4) {
    return null;
  }

  const modifiedOpcode = bytecode[offset + 1];
  const index = (bytecode[offset + 2] << 8) | bytecode[offset + 3];

  let length = 4;
  const info = {
    opcode: modifiedOpcode,
    index: index,
  };

  if (modifiedOpcode === 0x84) { // iinc
    info.const = (bytecode[offset + 4] << 8) | bytecode[offset + 5];
    length += 2;
  }

  return {
    instruction: {
      opcode: 0xc4,
      info: info,
      length: length,
    },
    length: length,
  };
}

module.exports = { parseWideInstruction };
