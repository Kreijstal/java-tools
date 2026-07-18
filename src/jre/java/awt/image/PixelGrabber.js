module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/awt/Image;IIII[III)V': (jvm, obj, args) => {
      [obj._image, obj._x, obj._y, obj._width, obj._height, obj._target, obj._offset, obj._scanSize] = args;
    },
    'grabPixels()Z': (jvm, obj) => {
      const source = obj._image && obj._image._pixels;
      if (!source || !obj._target) return 0;
      const sourceWidth = obj._image._width | 0;
      for (let y = 0; y < obj._height; y++) {
        for (let x = 0; x < obj._width; x++) {
          obj._target[obj._offset + y * obj._scanSize + x] = source[(obj._y + y) * sourceWidth + obj._x + x] | 0;
        }
      }
      return 1;
    },
  },
};
