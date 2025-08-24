const zlib = require('zlib');
const data = "Hello, World!";
const compressed = zlib.deflateRawSync(Buffer.from(data));
console.log('Hex: ' + compressed.toString('hex'));

let output = 'byte[] compressedData = {';
for (let i = 0; i < compressed.length; i++) {
    output += '(byte)0x' + compressed.toString('hex', i, i+1);
    if (i < compressed.length - 1) {
        output += ', ';
    }
}
output += '};';
console.log('\nJava code:\n' + output);
