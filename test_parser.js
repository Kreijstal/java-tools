const Parser = require('binary-parser').Parser;

const p = new Parser().uint8('tag').choice('data', {
  tag: 'tag',
  choices: {
    1: new Parser().string('a', { length: 4 }),
    2: new Parser().string('b', { length: 4 }),
  }
});

const buf = Buffer.from([1, 0x61, 0x62, 0x63, 0x64]);
console.log(p.parse(buf));
