'use strict';

const constants = require('../instructions/constants');
const loads = require('../instructions/loads');
const stores = require('../instructions/stores');
const stack = require('../instructions/stack');
const math = require('../instructions/math');
const control = require('../instructions/control');
const invoke = require('../instructions/invoke');
const objectOps = require('../instructions/object');
const conversions = require('../instructions/conversions');

function collectOpcodeNames() {
  const buckets = [
    constants,
    loads,
    stores,
    stack,
    math,
    control,
    invoke,
    objectOps,
    conversions,
  ];
  const names = new Set();
  buckets.forEach((bucket) => {
    if (bucket && typeof bucket === 'object') {
      Object.keys(bucket).forEach((name) => names.add(name));
    }
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

const OPCODE_NAMES = collectOpcodeNames();

module.exports = { OPCODE_NAMES };
