module.exports = {
  super: 'java/lang/Object',
  fields: {
    'width:I': 0,
    'height:I': 0,
    'rgbBitCount:I': 0,
    'refreshRate:I': 0,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.width = 0;
      obj.height = 0;
      obj.rgbBitCount = 0;
      obj.refreshRate = 0;
    },
  },
};
