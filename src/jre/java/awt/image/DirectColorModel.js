module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(IIII)V': (jvm, obj, args) => {
      obj._bits = args[0];
      obj._redMask = args[1];
      obj._greenMask = args[2];
      obj._blueMask = args[3];
      obj._alphaMask = 0;
    },
    '<init>(IIIII)V': (jvm, obj, args) => {
      obj._bits = args[0];
      obj._redMask = args[1];
      obj._greenMask = args[2];
      obj._blueMask = args[3];
      obj._alphaMask = args[4];
    },
    'createCompatibleSampleModel(II)Ljava/awt/image/SampleModel;': (jvm, obj, args) => ({
      type: 'java/awt/image/SinglePixelPackedSampleModel',
      _width: args[0],
      _height: args[1],
      _colorModel: obj,
    }),
  },
};
