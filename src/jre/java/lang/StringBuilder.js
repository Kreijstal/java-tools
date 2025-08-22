module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.value = '';
      delete obj.isUninitialized;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const str = args[0];
      if (str === null) {
        throw { type: 'java/lang/NullPointerException' };
      }
      obj.value = String(str);
      delete obj.isUninitialized;
    },
    'append(Ljava/lang/String;)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      const str = args[0];
      obj.value += str;
      return obj;
    },
    'append(I)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      const int = args[0];
      obj.value += int;
      return obj;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const strObj = new String(obj.value);
      strObj.type = 'java/lang/String';
      return strObj;
    },
    'reverse()Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      // Unicode-aware reversal using Array.from to handle surrogate pairs and combining marks
      obj.value = Array.from(obj.value).reverse().join('');
      return obj;
    },
  },
};
