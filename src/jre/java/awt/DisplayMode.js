module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getBitDepth()I': (jvm, obj) => obj.bitDepth || 0,
    'getHeight()I': (jvm, obj) => obj.height || 0,
    'getRefreshRate()I': (jvm, obj) => obj.refreshRate || 0,
    'getWidth()I': (jvm, obj) => obj.width || 0,
  },
};
