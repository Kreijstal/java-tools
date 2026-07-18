module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(IIII)V': (jvm, obj, args) => {
      obj._width = args[0]; obj._height = args[1];
      obj._bitDepth = args[2]; obj._refreshRate = args[3];
    },
    'getWidth()I': (jvm, obj) => obj._width | 0,
    'getHeight()I': (jvm, obj) => obj._height | 0,
    'getBitDepth()I': (jvm, obj) => obj._bitDepth | 0,
    'getRefreshRate()I': (jvm, obj) => obj._refreshRate | 0,
  },
};
