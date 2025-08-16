module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.value = '';
      delete obj.isUninitialized;
    },
    'append(Ljava/lang/String;)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      const str = args[0];
      obj.value += str;
      return obj;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.value);
    },
  },
};
