function arrayData(value) {
  if (value == null) return null;
  return value.array || value.elements || value;
}

function ensurePixels(image, minimumWidth = 0, minimumHeight = 0) {
  const width = Math.max(image._width | 0, minimumWidth | 0);
  const height = Math.max(image._height | 0, minimumHeight | 0);
  if (width <= 0 || height <= 0) return null;
  image._width = width;
  image._height = height;
  const count = width * height;
  if (!(image._pixels instanceof Int32Array) || image._pixels.length !== count) {
    const replacement = new Int32Array(count);
    if (image._pixels) replacement.set(
      Array.from(image._pixels).slice(0, count));
    image._pixels = replacement;
  }
  image._raster = {_dataBuffer: {_data: image._pixels}};
  return image._pixels;
}

function setPixels(jvm, obj, args) {
  const image = obj && obj._image;
  if (!image) return;
  const x = args[0] | 0;
  const y = args[1] | 0;
  const width = args[2] | 0;
  const height = args[3] | 0;
  const source = arrayData(args[5]);
  const offset = args[6] | 0;
  const scanline = args[7] | 0;
  if (!source || width <= 0 || height <= 0 || x < 0 || y < 0) return;
  const destination = ensurePixels(image, x + width, y + height);
  if (!destination) return;
  const destinationWidth = image._width | 0;
  for (let row = 0; row < height; row += 1) {
    const sourceStart = offset + row * scanline;
    const destinationStart = (y + row) * destinationWidth + x;
    if (width === destinationWidth && x === 0 &&
        sourceStart >= 0 && sourceStart + width <= source.length) {
      destination.set(source.slice
        ? source.slice(sourceStart, sourceStart + width)
        : Array.from(source).slice(sourceStart, sourceStart + width),
      destinationStart);
      continue;
    }
    for (let column = 0; column < width; column += 1) {
      destination[destinationStart + column] = source[sourceStart + column] | 0;
    }
  }
  image._pixelsUpdated = true;
  image._frameComplete = false;
}

module.exports = {
  super: 'java/lang/Object',
  isInterface: true,
  interfaces: [],
  // The host consumer receives producer callbacks through invokeinterface.
  // Keeping the declarations and implementations together preserves interface
  // dispatch while providing the backing storage used by java.awt.Image.
  methods: {
    'imageComplete(I)V': (jvm, obj, args) => {
      const image = obj && obj._image;
      if (!image) return;
      const status = args[0] | 0;
      image._completionStatus = status;
      if (status === 2 || status === 3) {
        image._frameComplete = true;
        image._completedVersion = (image._completedVersion || 0) + 1;
      } else if (status === 1 || status === 4) {
        image._frameComplete = false;
      }
    },
    'setColorModel(Ljava/awt/image/ColorModel;)V': (jvm, obj, args) => {
      if (obj && obj._image) obj._image._colorModel = args[0] || null;
    },
    'setDimensions(II)V': (jvm, obj, args) => {
      const image = obj && obj._image;
      if (!image) return;
      image._width = args[0] | 0;
      image._height = args[1] | 0;
      ensurePixels(image);
    },
    'setHints(I)V': (jvm, obj, args) => {
      if (obj && obj._image) obj._image._consumerHints = args[0] | 0;
    },
    'setPixels(IIIILjava/awt/image/ColorModel;[BII)V': setPixels,
    'setPixels(IIIILjava/awt/image/ColorModel;[III)V': setPixels,
    'setProperties(Ljava/util/Hashtable;)V': (jvm, obj, args) => {
      if (obj && obj._image) obj._image._properties = args[0] || null;
    },
  },
  staticFields: {
    'RANDOMPIXELORDER:I': 1,
    'TOPDOWNLEFTRIGHT:I': 2,
    'COMPLETESCANLINES:I': 4,
    'SINGLEPASS:I': 8,
    'SINGLEFRAME:I': 16,
    'IMAGEERROR:I': 1,
    'SINGLEFRAMEDONE:I': 2,
    'STATICIMAGEDONE:I': 3,
    'IMAGEABORTED:I': 4,
  },
};
