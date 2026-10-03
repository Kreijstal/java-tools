'use strict';
const test = require('tape');
const Graphics = require('../src/jre/java/awt/Graphics');
const draw = Graphics.methods['drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z'];

for (const ArrayType of [Int32Array, Uint32Array, Array]) {
  test(`AWT full-frame copy preserves padded ${ArrayType.name} raster`, t => {
    const storage = ArrayType.from([7, 0x112233, 0xffffffff, 0xabcdef, 99]);
    const pixels = ArrayType === Array ? storage.slice(1) : storage.subarray(1);
    const target = {_width:3, _height:1};
    const image = {_width:3, _height:1, _raster:{_dataBuffer:{_data:pixels}}};
    t.equal(draw({}, {_component:target}, [image, 0, 0, null]), 1);
    t.deepEqual(Array.from(target._pixels), [0x112233, -1, 0xabcdef], 'only the visible prefix is published');
    t.equal(pixels[3], 99, 'padding remains unchanged');
    pixels[0] = 42;
    t.equal(target._pixels[0], 0x112233, 'publication is independent of subsequent raster writes');
    const prior = target._pixels;
    draw({}, {_component:target}, [image, 0, 0, null]);
    t.equal(target._pixels, prior, 'subsequent frames reuse destination storage');
    t.equal(target._pixels[0], 42, 'subsequent frames publish new contents');
    t.end();
  });
}
