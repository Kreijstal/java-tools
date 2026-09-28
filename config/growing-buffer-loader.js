'use strict';
const path = require('node:path');

// Apply the browser cache optimization at bundle time without modifying the
// installed dependency. Refuse an unfamiliar implementation on upgrades.
module.exports = function growingBufferLoader(source) {
  const anchor = 'export function extendBuffer(buffer, newByteLength) {';
  if (source.split(anchor).length !== 2) {
    throw new Error('utilium extendBuffer changed; review browser buffer growth integration');
  }
  const helper = path.resolve(__dirname, '../src/io/growByteView.js');
  return `import growByteView from ${JSON.stringify(helper)};\n` + source.replace(anchor,
    anchor + '\n    const grown = growByteView(buffer, newByteLength);\n    if (grown !== null) return grown;');
};
