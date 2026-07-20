'use strict';

const test = require('tape');
const path = require('path');

const File = require('../src/jre/java/io/File');
const HashMap = require('../src/jre/java/util/HashMap');
const Pattern = require('../src/jre/java/util/regex/Pattern');
const Matcher = require('../src/jre/java/util/regex/Matcher');
const StringClass = require('../src/jre/java/lang/String');
const CRC32 = require('../src/jre/java/util/zip/CRC32');
const SourceDataLine = require('../src/jre/javax/sound/sampled/SourceDataLine');
const Toolkit = require('../src/jre/java/awt/Toolkit');
const ImageClass = require('../src/jre/java/awt/Image');
const PixelGrabber = require('../src/jre/java/awt/image/PixelGrabber');
const Graphics = require('../src/jre/java/awt/Graphics');
const { setAudioOutputFactory } = require('../src/platform/audio');
const { encodePng } = require('../src/io/pngEncoder');
const jpeg = require('jpeg-js');
const Class = require('../src/jre/java/lang/Class');

function jvmStub() {
  return {
    nextHashCode: 1,
    internString(value) {
      const str = new String(String(value));
      str.type = 'java/lang/String';
      return str;
    },
  };
}

test('Class.newInstance reports InstantiationException for primitive classes', async (t) => {
  let error = null;
  try {
    await Class.methods['newInstance()Ljava/lang/Object;'](
      {}, { className: 'int', _classData: null }, [], null,
    );
  } catch (caught) {
    error = caught;
  }
  t.equal(error && error.type, 'java/lang/InstantiationException');
  t.end();
});

test('File constructors coerce Java String objects without value fields', (t) => {
  const jvm = jvmStub();
  const parent = jvm.internString('tmp');
  const child = jvm.internString('child.txt');
  const obj = {};

  File.methods['<init>(Ljava/lang/String;Ljava/lang/String;)V'](jvm, obj, [parent, child]);

  t.equal(obj.path, path.join('tmp', 'child.txt'));
  t.end();
});

test('HashMap.computeIfAbsent does not record null mapping results', (t) => {
  const map = {};
  const fn = {
    methods: {
      'apply(Ljava/lang/Object;)Ljava/lang/Object;': () => null,
    },
  };

  HashMap.methods['<init>()V'](null, map, []);
  const value = HashMap.methods['computeIfAbsent(Ljava/lang/Object;Ljava/util/function/Function;)Ljava/lang/Object;'](null, map, ['k', fn]);

  t.equal(value, null);
  t.equal(HashMap.methods['containsKey(Ljava/lang/Object;)Z'](null, map, ['k']), 0);
  t.equal(HashMap.methods['size()I'](null, map, []), 0);
  t.end();
});

test('CRC32 treats signed Java bytes as unsigned octets', (t) => {
  const obj = {};

  CRC32.methods['<init>()V'](null, obj, []);
  CRC32.methods['update([BII)V'](null, obj, [[-1, 0, 127, -128], 0, 4]);

  t.equal(CRC32.methods['getValue()J'](null, obj, []), 0xba5e3ff4n);
  t.end();
});

test('headless SourceDataLine discard sink closes cleanly', (t) => {
  const obj = {};
  const format = {
    fields: {
      'javax/sound/sampled/AudioFormat': {},
    },
  };

  setAudioOutputFactory(() => { throw new Error('no audio device'); });
  SourceDataLine.methods['open(Ljavax/sound/sampled/AudioFormat;)V'](null, obj, [format]);
  t.doesNotThrow(() => SourceDataLine.methods['close()V'](null, obj, []));
  setAudioOutputFactory(null);
  t.end();
});

test('disabled SourceDataLine applies backpressure', (t) => {
  const previous = process.env.JVM_DISABLE_AUDIO;
  process.env.JVM_DISABLE_AUDIO = '1';

  t.equal(SourceDataLine.methods['available()I'](null, {}, []), 0);

  if (previous === undefined) delete process.env.JVM_DISABLE_AUDIO;
  else process.env.JVM_DISABLE_AUDIO = previous;
  t.end();
});

test('Toolkit decodes GIF dimensions and PixelGrabber pixels', (t) => {
  const gif = Array.from(
    Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
    (value) => (value << 24) >> 24,
  );
  const image = Toolkit.methods['createImage([B)Ljava/awt/Image;'](null, null, [gif]);
  const target = [0];
  const grabber = {};

  t.equal(ImageClass.methods['getWidth(Ljava/awt/image/ImageObserver;)I'](null, image, [null]), 1);
  t.equal(ImageClass.methods['getHeight(Ljava/awt/image/ImageObserver;)I'](null, image, [null]), 1);
  PixelGrabber.methods['<init>(Ljava/awt/Image;IIII[III)V'](
    null,
    grabber,
    [image, 0, 0, 1, 1, target, 0, 1],
  );
  t.equal(PixelGrabber.methods['grabPixels()Z'](null, grabber, []), 1);
  t.equal(target[0] >>> 0, 0xffffffff);
  t.end();
});

test('Toolkit decodes PNG pixels', (t) => {
  const png = Array.from(encodePng([0x123456, 0xabcdef], 2, 1), (value) => (value << 24) >> 24);
  const image = Toolkit.methods['createImage([B)Ljava/awt/Image;'](null, null, [png]);

  t.equal(image._width, 2);
  t.equal(image._height, 1);
  t.deepEqual(image._pixels.map((pixel) => pixel >>> 0), [0xff123456, 0xffabcdef]);
  t.end();
});

test('Toolkit decodes JPEG dimensions and pixels', (t) => {
  const encoded = jpeg.encode({
    width: 1,
    height: 1,
    data: Buffer.from([220, 40, 20, 255]),
  }, 100).data;
  const image = Toolkit.methods['createImage([B)Ljava/awt/Image;'](null, null, [encoded]);
  const pixel = image._pixels[0] >>> 0;

  t.equal(image._width, 1);
  t.equal(image._height, 1);
  t.ok((pixel >> 16 & 0xff) > 180, 'red channel survives JPEG decoding');
  t.end();
});

test('AWT producer blits coalesce dirty presentation on animation frames', (t) => {
  const previousRaf = global.requestAnimationFrame;
  const callbacks = [];
  global.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  const uploads = [];
  const context = {
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image) {
      uploads.push(Array.from(image.data));
    },
  };
  const target = {
    _width: 2,
    _height: 1,
    _canvasElement: { width: 2, height: 1, getContext: () => context },
  };
  const jvm = {};
  const graphics = { _component: target };
  const sourcePixels = [0x112233, 0xaabbcc];
  const image = {
    _producer: { width: 2, height: 1, pixels: sourcePixels },
  };
  const draw = Graphics.methods['drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z'];

  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1,
    'software producer image is accepted');
  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1,
    'a second dirty frame is accepted before presentation');
  t.equal(callbacks.length, 1, 'dirty frames share one pending animation callback');
  t.equal(jvm._awtPresentationStats.coalesced, 1, 'coalesced frame is counted');
  t.notEqual(target._pixels, sourcePixels, 'full-frame publication snapshots the producer buffer');
  sourcePixels[0] = 0xffffff;
  t.equal(target._pixels[0], 0x112233, 'published frame is stable while producer renders the next frame');

  callbacks.shift()(0);
  t.equal(uploads.length, 1, 'latest dirty surface is uploaded once');
  t.deepEqual(uploads[0], [0x11, 0x22, 0x33, 0xff, 0xaa, 0xbb, 0xcc, 0xff],
    'RGB producer pixels are converted to RGBA ImageData');
  t.equal(jvm._awtPresentationStats.presented, 1, 'completed upload is counted');

  if (previousRaf === undefined) delete global.requestAnimationFrame;
  else global.requestAnimationFrame = previousRaf;
  t.end();
});

test('String.format supports javac varargs object array hex formatting', (t) => {
  const jvm = jvmStub();
  const result = StringClass.staticMethods['format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;'](jvm, null, [
    jvm.internString('#%02x%02x%02x'),
    [
      { type: 'java/lang/Integer', value: 255 },
      { type: 'java/lang/Integer', value: 0 },
      { type: 'java/lang/Integer', value: 0 },
    ],
  ]);

  t.equal(result.toString(), '#ff0000');
  t.end();
});

test('regex Pattern flags apply to matcher, split, and replace operations', (t) => {
  const jvm = jvmStub();
  const literalDot = Pattern.staticMethods['compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;'](jvm, null, [
    jvm.internString('.'),
    Pattern.staticFields['LITERAL:I'],
  ]);
  const matcher = Pattern.methods['matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;'](jvm, literalDot, [
    jvm.internString('a.b'),
  ]);

  t.equal(Matcher.methods['find()Z'](jvm, matcher, []), 1, 'literal dot finds the actual dot');
  t.equal(Matcher.methods['group()Ljava/lang/String;'](jvm, matcher, []).toString(), '.', 'literal dot group is the dot');
  const split = Pattern.methods['split(Ljava/lang/CharSequence;)[Ljava/lang/String;'](jvm, literalDot, [jvm.internString('a.b')]);
  t.deepEqual(split.map(String), ['a', 'b'], 'split uses quoted literal pattern');

  const replaced = Matcher.methods['replaceAll(Ljava/lang/String;)Ljava/lang/String;'](jvm, matcher, [jvm.internString('X')]);
  t.equal(replaced.toString(), 'aXb', 'replaceAll uses quoted literal pattern');

  const dotAll = Pattern.staticMethods['compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;'](jvm, null, [
    jvm.internString('a.b'),
    Pattern.staticFields['DOTALL:I'],
  ]);
  const dotAllMatcher = Pattern.methods['matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;'](jvm, dotAll, [
    jvm.internString('a\nb'),
  ]);
  t.equal(Matcher.methods['matches()Z'](jvm, dotAllMatcher, []), 1, 'DOTALL lets dot match newline');

  t.end();
});

test('regex Matcher reports capture-group start and end offsets', (t) => {
  const jvm = jvmStub();
  const pattern = Pattern.staticMethods['compile(Ljava/lang/String;)Ljava/util/regex/Pattern;'](jvm, null, [
    jvm.internString('a(b+)c'),
  ]);
  const matcher = Pattern.methods['matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;'](jvm, pattern, [
    jvm.internString('xxabbc'),
  ]);

  t.equal(Matcher.methods['find()Z'](jvm, matcher, []), 1);
  t.equal(Matcher.methods['start(I)I'](jvm, matcher, [1]), 3);
  t.equal(Matcher.methods['end(I)I'](jvm, matcher, [1]), 5);
  t.end();
});
