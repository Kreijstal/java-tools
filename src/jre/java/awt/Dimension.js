module.exports = {
  super: 'java/lang/Object',
  fields: {
    'width:I': 0,
    'height:I': 0,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.width = 0;
      obj.height = 0;
    },
    '<init>(II)V': (jvm, obj, args) => {
      obj.width = args[0];
      obj.height = args[1];
    },
  },
};
