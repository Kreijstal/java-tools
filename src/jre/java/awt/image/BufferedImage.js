// The int pixels live in the raster's DataBufferInt for both constructors; the
// four-argument one takes a raster the caller built.
function pixelData(obj) {
  const raster = obj._raster;
  const buffer = raster && raster._dataBuffer;
  return buffer ? buffer._data : null;
}

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

    // Pixel access over the backing DataBufferInt. The frontend was inventing a
    // descriptor for setRGB because the model did not declare it; the invented
    // one links and then throws NoSuchMethodError on the first draw.
    'getRGB(II)I': (jvm, obj, args) => {
      const data = pixelData(obj);
      if (!data) return 0;
      return data[args[1] * obj._width + args[0]] | 0;
    },
    'setRGB(III)V': (jvm, obj, args) => {
      const data = pixelData(obj);
      if (!data) return;
      data[args[1] * obj._width + args[0]] = args[2] | 0;
    },
    'setRGB(IIII[III)V': (jvm, obj, args) => {
      const [startX, startY, width, height, rgb, offset, scansize] = args;
      const data = pixelData(obj);
      if (!data) return;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          data[(startY + y) * obj._width + startX + x] = rgb[offset + y * scansize + x] | 0;
        }
      }
    },
    'getRGB(IIII[III)[I': (jvm, obj, args) => {
      const [startX, startY, width, height, rgbArg, offset, scansize] = args;
      const data = pixelData(obj);
      const rgb = rgbArg || new Array(offset + height * scansize).fill(0);
      if (!data) return rgb;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          rgb[offset + y * scansize + x] = data[(startY + y) * obj._width + startX + x] | 0;
        }
      }
      return rgb;
    },
  },
};
