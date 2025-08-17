const { Lang } = require('./krak2_parser.js');

/**
 * Parses a string of Krakatau2 assembly code into a JavaScript object.
 * @param {string} assemblyCode - The Krakatau2 assembly code to parse.
 * @returns {object} The parsed class structure.
 */
function parseKrak2Assembly(assemblyCode) {
  const result = Lang.source_file.tryParse(assemblyCode);
  return result;
}

module.exports = { parseKrak2Assembly };
