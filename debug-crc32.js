// Test CRC32 calculation in Node.js
const crc32 = require('crc-32');

const testString = "Hello, World!";
const bytes = Buffer.from(testString, 'utf8');
console.log('Test string:', testString);
console.log('Bytes:', Array.from(bytes));
console.log('CRC32 calculated:', crc32.buf(bytes));
console.log('CRC32 unsigned:', crc32.buf(bytes) >>> 0);
console.log('Expected:', 3964322768);