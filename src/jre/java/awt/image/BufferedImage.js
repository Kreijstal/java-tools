module.exports = {
  super: 'java/awt/Image',
  methods: {
    '<init>(Ljava/awt/image/ColorModel;Ljava/awt/image/WritableRaster;ZLjava/util/Hashtable;)V': (jvm, obj, args) => {
      obj._colorModel = args[0];
      obj._raster = args[1];
      const sm = args[1] && args[1]._sampleModel;
      obj._width = sm ? sm._width : 0;
      obj._height = sm ? sm._height : 0;
    },
    '<init>(III)V': (jvm, obj, args) => {
      obj._width = args[0];
      obj._height = args[1];
      obj._imageType = args[2];
      obj._raster = {
        type: 'java/awt/image/WritableRaster',
        _sampleModel: { type: 'java/awt/image/SinglePixelPackedSampleModel', _width: args[0], _height: args[1] },
        _dataBuffer: { type: 'java/awt/image/DataBufferInt', _data: new Array(args[0] * args[1]).fill(0) },
      };
    },
    'getWidth()I': (jvm, obj) => obj._width | 0,
    'getHeight()I': (jvm, obj) => obj._height | 0,
    'getRaster()Ljava/awt/image/WritableRaster;': (jvm, obj) => obj._raster,
  },
};
