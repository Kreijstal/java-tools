'use strict';

module.exports = {
  ...require('./ast'),
  ...require('./serialization'),
  ...require('./errors'),
  ...require('./lexer'),
  ...require('./parser'),
  ...require('./semantic'),
  ...require('./frontend'),
  ...require('./compiler'),
  ...require('./javaIr'),
  ...require('./jvmBytecodeIr'),
  ...require('./annotations'),
  ...require('./traversal'),
  ...require('./passManager'),
  ...require('./cfg'),
  ...require('../cfg/cfgJoin'),
  ...require('./cfgJoinPasses'),
  ...require('./passStubs'),
};
