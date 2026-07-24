'use strict';

const test = require('tape');
const path = require('path');

const File = require('../src/jre/java/io/File');
const HashMap = require('../src/jre/java/util/HashMap');
const Hashtable = require('../src/jre/java/util/Hashtable');
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
const Vector = require('../src/jre/java/util/Vector');
const Thread = require('../src/jre/java/lang/Thread');
const ThreadGroup = require('../src/jre/java/lang/ThreadGroup');
const JNI = require('../src/core/jni');
const ByteBuffer = require('../src/jre/java/nio/ByteBuffer');
const Random = require('../src/jre/java/util/Random');
const ActionEvent = require('../src/jre/java/awt/event/ActionEvent');
const { decodePng } = require('../src/io/gifDecoder');

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

test('Vector.insertElementAt inserts in order and checks its index', (t) => {
  const vector = {};
  Vector.methods['<init>()V'](null, vector, []);
  Vector.methods['insertElementAt(Ljava/lang/Object;I)V'](
    null, vector, ['tail', 0],
  );
  Vector.methods['insertElementAt(Ljava/lang/Object;I)V'](
    null, vector, ['head', 0],
  );

  t.deepEqual(vector.items, ['head', 'tail']);
  t.equal(vector.size, 2);
  let error = null;
  try {
    Vector.methods['insertElementAt(Ljava/lang/Object;I)V'](
      null, vector, ['invalid', 3],
    );
  } catch (caught) {
    error = caught;
  }
  t.equal(error && error.type, 'java/lang/ArrayIndexOutOfBoundsException');
  t.end();
});

test('Vector capacity is not content and addElement appends', (t) => {
  const vector = {};
  const methods = Vector.methods;
  methods['<init>(I)V'](null, vector, [8]);
  t.equal(methods['size()I'](null, vector, []), 0,
    'capacity constructor creates an empty Vector');
  methods['addElement(Ljava/lang/Object;)V'](null, vector, ['first']);
  t.equal(methods['add(Ljava/lang/Object;)Z'](null, vector, ['second']), 1,
    'Collection.add reports success');
  t.deepEqual(methods['toArray()[Ljava/lang/Object;'](null, vector, []),
    ['first', 'second'], 'legacy and Collection append paths share logical contents');
  t.end();
});

test('current and child threads inherit a non-null system thread group', (t) => {
  const jvm = jvmStub();
  const internalThread = {
    id: 0,
    name: 'main',
    status: 'runnable',
  };
  jvm.threads = [internalThread];
  jvm.currentThreadIndex = 0;

  const main = Thread.staticMethods['currentThread()Ljava/lang/Thread;'](
    jvm, null, [],
  );
  const group = Thread.methods['getThreadGroup()Ljava/lang/ThreadGroup;'](
    jvm, main, [],
  );
  const child = {};
  Thread.methods['<init>(Ljava/lang/Runnable;)V'](
    jvm, child, [{}], internalThread,
  );
  const enumerated = new Array(4);

  t.ok(group, 'the current JVM thread has a group');
  t.equal(
    ThreadGroup.methods['getParent()Ljava/lang/ThreadGroup;'](
      jvm, group, [],
    ),
    null,
    'the synthetic system group is the root',
  );
  t.equal(child.threadGroup, group, 'new threads inherit the current group');
  t.equal(
    ThreadGroup.methods['enumerate([Ljava/lang/Thread;)I'](
      jvm, group, [enumerated],
    ),
    1,
    'enumeration includes the active main thread',
  );
  t.equal(enumerated[0], main);

  const nativeJvm = jvmStub();
  nativeJvm.threads = [{ id: 0, name: 'main', status: 'runnable' }];
  nativeJvm.currentThreadIndex = 0;
  const nativeCurrentThread = new JNI(nativeJvm).findNativeMethod(
    'java/lang/Thread', 'currentThread', '()Ljava/lang/Thread;',
  );
  const nativeMain = nativeCurrentThread(nativeJvm, null, [],
    nativeJvm.threads[0]);
  t.ok(nativeMain.threadGroup,
    'the JNI currentThread path supplies the same group semantics');
  t.end();
});

test('ByteBuffer exposes the covariant Buffer position bridge', (t) => {
  const buffer = ByteBuffer.staticMethods[
    'allocateDirect(I)Ljava/nio/ByteBuffer;'
  ](null, null, [8]);
  buffer['java/nio/Buffer/mark'] = 6;
  const result = ByteBuffer.methods[
    'position(I)Ljava/nio/Buffer;'
  ](null, buffer, [4]);

  t.equal(result, buffer);
  t.equal(buffer['java/nio/Buffer/position'], 4);
  t.equal(buffer['java/nio/Buffer/mark'], -1,
    'moving before the mark discards it');
  t.end();
});

test('Random.nextGaussian uses the JVM random state directly', (t) => {
  const random = {};
  Random.methods['<init>(J)V'](null, random, [0n]);
  const first = Random.methods['nextGaussian()D'](null, random, []);
  const second = Random.methods['nextGaussian()D'](null, random, []);

  t.ok(Number.isFinite(first));
  t.ok(Number.isFinite(second));
  t.equal(random['java/util/Random/haveNextNextGaussian'], false,
    'the second call consumes the cached Box-Muller result');
  t.end();
});

test('PNG decoder reconstructs Adam7 interlaced pixels', (t) => {
  const encoded = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAAGuTRJ+AAAAIGNIUk0AAHomAACAhAAA' +
    '+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdE' +
    'lNRQfqBxcIDQC/WA6HAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA3LTIzVDA4OjEz' +
    'OjAwKzAwOjAwuR0kogAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNy0yM1QwODoxMz' +
    'owMCswMDowMMhAnB4AAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDctMjNUMDg6' +
    'MTM6MDArMDA6MDCfVb3BAAAAHElEQVQI1wXBAQ0AAAjAIJzFbX5BoFU3QyQVygO2Zw' +
    'x6AjvG6AAAAABJRU5ErkJggg==',
    'base64',
  );
  const image = decodePng(encoded);

  t.equal(image.width, 3);
  t.equal(image.height, 3);
  t.deepEqual(image.pixels.map((pixel) => pixel >>> 0), [
    0xffff0000, 0xff00ff00, 0xff0000ff,
    0xffffffff, 0xff000000, 0xffffff00,
    0xff00ffff, 0xffff00ff, 0xff808080,
  ]);
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

test('Hashtable capacity constructors initialize storage', (t) => {
  for (const [descriptor, args] of [['<init>(I)V', [16]], ['<init>(IF)V', [16, 0.75]]]) {
    const table = {};
    Hashtable.methods[descriptor](null, table, args);
    Hashtable.methods['put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;'](
      null, table, ['key', 'value'],
    );
    t.equal(Hashtable.methods['get(Ljava/lang/Object;)Ljava/lang/Object;'](
      null, table, ['key'],
    ), 'value', `${descriptor} creates usable backing storage`);
  }
  t.end();
});

test('ActionEvent constructors retain event state', (t) => {
  const event = {};
  const source = {};
  ActionEvent.methods['<init>(Ljava/lang/Object;ILjava/lang/String;JI)V'](
    null, event, [source, 1001, 'launch', 42n, 3],
  );
  t.equal(ActionEvent.methods['getSource()Ljava/lang/Object;'](null, event), source);
  t.equal(ActionEvent.methods['getActionCommand()Ljava/lang/String;'](null, event), 'launch');
  t.equal(ActionEvent.methods['getWhen()J'](null, event), 42n);
  t.equal(ActionEvent.methods['getModifiers()I'](null, event), 3);
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

test('Toolkit preserves hidden RGB channels in transparent PNG pixels', (t) => {
  const encoded = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDctMjNUMTA6MzY6NDYrMDA6MDAnzl/8AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA3LTIzVDEwOjM2OjQ2KzAwOjAwVpPnQAAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wNy0yM1QxMDozNjo0NiswMDowMAGGxp8AAAANSURBVAjXYxAyCWMAAAGVAJ22RGelAAAAAElFTkSuQmCC',
    'base64',
  );
  const png = Array.from(encoded, (value) => (value << 24) >> 24);
  const image = Toolkit.methods['createImage([B)Ljava/awt/Image;'](null, null, [png]);

  t.equal(image._pixels[0] >>> 0, 0x00123456,
    'transparent ARGB retains its nonzero RGB payload');
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

test('headless AWT blits expose an uncapped coalesced presentation boundary', (t) => {
  const target = { _width: 2, _height: 1 };
  const jvm = {};
  const graphics = { _component: target };
  const image = {
    _producer: { width: 2, height: 1, pixels: [0x112233, 0xaabbcc] },
  };
  const draw = Graphics.methods[
    'drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z'
  ];

  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1);
  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1);
  t.equal(jvm._awtPresentationStats.scheduled, 1,
    'one host-turn presentation is scheduled without a browser canvas');
  t.equal(jvm._awtPresentationStats.coalesced, 1,
    'multiple publications in the same turn are coalesced');
  t.equal(jvm._awtPresentationStats.presented, 0,
    'presentation is not counted before its event-loop boundary');

  setImmediate(() => {
    t.equal(jvm._awtPresentationStats.presented, 1,
      'completed headless software frame is counted');
    t.equal(target._presentedVersion, target._pixelsVersion,
      'the counted boundary observes the latest published surface');
    t.end();
  });
});

test('AWT full-frame presentation uses exact Wasm RGB swizzle', (t) => {
  const previousRaf = global.requestAnimationFrame;
  const callbacks = [];
  global.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  const width = 256;
  const height = 256;
  const count = width * height;
  const sourcePixels = new Int32Array(count);
  sourcePixels[0] = 0x010203;
  sourcePixels[count >> 1] = 0x7f80ff;
  sourcePixels[count - 1] = 0xfedcba;
  let uploaded = null;
  const context = {
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(image) {
      const middle = (count >> 1) * 4;
      const last = (count - 1) * 4;
      uploaded = {
        first: Array.from(image.data.subarray(0, 4)),
        middle: Array.from(image.data.subarray(middle, middle + 4)),
        last: Array.from(image.data.subarray(last, last + 4)),
      };
    },
  };
  const target = {
    _width: width,
    _height: height,
    _canvasElement: { width, height, getContext: () => context },
  };
  const jvm = {};
  const graphics = { _component: target };
  const image = { _producer: { width, height, pixels: sourcePixels } };
  const draw = Graphics.methods['drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z'];

  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1);
  t.equal(callbacks.length, 1, 'full frame schedules one presentation');
  callbacks.shift()(0);

  t.deepEqual(uploaded, {
    first: [0x01, 0x02, 0x03, 0xff],
    middle: [0x7f, 0x80, 0xff, 0xff],
    last: [0xfe, 0xdc, 0xba, 0xff],
  }, 'Wasm conversion preserves RGB channels and supplies opaque alpha');
  t.equal(jvm._awtPresentationStats.wasmSwizzles, 1,
    'large presentation records the Wasm swizzle path');
  t.equal(jvm._awtPresentationStats.jsSwizzles, 0,
    'large presentation does not execute the scalar JS converter');

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
