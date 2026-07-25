module.exports = {
  super: 'java/lang/Object',
  methods: {},
  staticMethods: {
    'createWritableRaster(Ljava/awt/image/SampleModel;Ljava/awt/image/DataBuffer;Ljava/awt/Point;)Ljava/awt/image/WritableRaster;': (jvm, obj, args) => ({
      type: 'java/awt/image/WritableRaster',
      _sampleModel: args[0],
      _dataBuffer: args[1],
    }),
  },
};
