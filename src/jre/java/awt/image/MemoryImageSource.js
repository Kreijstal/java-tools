const ImageConsumer = require('./ImageConsumer');

function publish(obj, consumer) {
  if (!consumer || !obj.pixels) return;
  const methods = ImageConsumer.methods;
  methods['setDimensions(II)V'](null, consumer, [obj.width, obj.height]);
  methods['setProperties(Ljava/util/Hashtable;)V'](null, consumer, [null]);
  methods['setColorModel(Ljava/awt/image/ColorModel;)V'](
    null, consumer, [obj.colorModel || null]);
  methods['setHints(I)V'](null, consumer, [14]);
  methods['setPixels(IIIILjava/awt/image/ColorModel;[III)V'](
    null, consumer,
    [0, 0, obj.width, obj.height, obj.colorModel || null,
      obj.pixels, obj.offset, obj.scanline]);
  methods['imageComplete(I)V'](null, consumer, [2]);
}

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/awt/image/ImageProducer'],
  methods: {
    '<init>(II[III)V': (jvm, obj, args) => {
      obj.width = args[0] || 0;
      obj.height = args[1] || 0;
      obj.pixels = args[2] || null;
      obj.offset = args[3] || 0;
      obj.scanline = args[4] || obj.width;
      obj.consumers = new Set();
    },
    'newPixels()V': (jvm, obj, args) => {
      for (const consumer of obj.consumers || []) publish(obj, consumer);
    },
    'addConsumer(Ljava/awt/image/ImageConsumer;)V': (jvm, obj, args) => {
      if (!obj.consumers) obj.consumers = new Set();
      if (args[0]) obj.consumers.add(args[0]);
    },
    'isConsumer(Ljava/awt/image/ImageConsumer;)Z': (jvm, obj, args) =>
      obj.consumers?.has(args[0]) ? 1 : 0,
    'removeConsumer(Ljava/awt/image/ImageConsumer;)V': (jvm, obj, args) => {
      obj.consumers?.delete(args[0]);
    },
    'startProduction(Ljava/awt/image/ImageConsumer;)V': (jvm, obj, args) => {
      if (!obj.consumers) obj.consumers = new Set();
      if (args[0]) {
        obj.consumers.add(args[0]);
        publish(obj, args[0]);
      }
    },
    'requestTopDownLeftRightResend(Ljava/awt/image/ImageConsumer;)V': (
      jvm, obj, args) => publish(obj, args[0]),
  },
};
