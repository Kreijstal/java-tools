module.exports = {
  super: 'java/lang/Object',
  isAbstract: true,
  methods: {
    'getGraphics()Ljava/awt/Graphics;': (jvm, obj, args) => {
      if (!obj._awtImage || !obj._awtImage.getGraphics) {
        return null;
      }
      return {
        type: 'java/awt/Graphics',
        _awtGraphics: obj._awtImage.getGraphics()
      };
    },
    'getWidth(Ljava/awt/image/ImageObserver;)I': (jvm, obj, args) => {
      if (Number.isFinite(obj._width)) return obj._width | 0;
      if (!obj._awtImage || !obj._awtImage.getWidth) {
        return 0;
      }
      return obj._awtImage.getWidth();
    },
    'getHeight(Ljava/awt/image/ImageObserver;)I': (jvm, obj, args) => {
      if (Number.isFinite(obj._height)) return obj._height | 0;
      if (!obj._awtImage || !obj._awtImage.getHeight) {
        return 0;
      }
      return obj._awtImage.getHeight();
    }
  },
};
