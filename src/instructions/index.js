const constants = require('./constants');
const loads = require('./loads');
const stores = require('./stores');
const stack = require('./stack');
const math = require('./math');
const control = require('./control');
const invoke = require('./invoke');
const object = require('./object');

const instructions = {
  ...constants,
  ...loads,
  ...stores,
  ...stack,
  ...math,
  ...control,
  ...invoke,
  ...object,
};

module.exports = function dispatch(frame, instruction, jvm) {
  const op = typeof instruction === 'string' ? instruction : instruction.op;

  const func = instructions[op];
  if (func) {
    func(frame, instruction, jvm);
  } else {
    throw new Error(`Unknown or unimplemented instruction: ${op}`);
  }
};
