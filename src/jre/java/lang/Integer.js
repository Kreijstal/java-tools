module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    'valueOf(I)Ljava/lang/Integer;': (jvm, _, args) => {
      return {
        type: 'java/lang/Integer',
        value: args[0],
      };
    },
    'intValue()I': (jvm, obj, args) => {
      return obj.value;
    },
  },
};
