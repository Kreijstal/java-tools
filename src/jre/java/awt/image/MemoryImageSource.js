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
    },
    'newPixels()V': (jvm, obj, args) => {
      obj._pixelsDirty = true;
    },
  },
};
