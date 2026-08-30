const rgbDefault = {
  type: 'java/awt/image/DirectColorModel',
  _bits: 32,
  _redMask: 0x00ff0000,
  _greenMask: 0x0000ff00,
  _blueMask: 0x000000ff,
  _alphaMask: 0xff000000 | 0,
};

module.exports = {
  super: 'java/lang/Object',
  methods: {
    'createCompatibleSampleModel(II)Ljava/awt/image/SampleModel;': () => null,
  },
  staticMethods: {
    'getRGBdefault()Ljava/awt/image/ColorModel;': () => rgbDefault,
  },
};
