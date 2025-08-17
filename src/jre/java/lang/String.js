module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    'concat(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      return obj + args[0];
    },
    'toUpperCase()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.toUpperCase();
    },
    'toLowerCase()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.toLowerCase();
    },
    'length()I': (jvm, obj, args) => {
      return obj.length;
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      return obj === args[0] ? 1 : 0;
    },
    'substring(II)Ljava/lang/String;': (jvm, obj, args) => {
        throw new Error('NotImplementedError: String.substring is not implemented.');
    },
  },
};
