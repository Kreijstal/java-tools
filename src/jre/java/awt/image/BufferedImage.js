module.exports = {
  super: 'java/awt/Image',
  methods: {
    '<init>(III)V': (jvm, obj, args) => {
      obj.width = args[0] || 0;
      obj.height = args[1] || 0;
      obj.imageType = args[2] || 0;
    },
    '<init>(Ljava/awt/image/ColorModel;Ljava/awt/image/WritableRaster;ZLjava/util/Hashtable;)V': () => {},
    'setRGB(IIII[III)V': () => {},
  },
};
