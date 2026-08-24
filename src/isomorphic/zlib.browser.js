'use strict';

const pako = require('pako');

function inflateSync(value) {
  return Buffer.from(pako.inflate(value));
}

function inflateRawSync(value) {
  return Buffer.from(pako.inflateRaw(value));
}

module.exports = { inflateSync, inflateRawSync };
