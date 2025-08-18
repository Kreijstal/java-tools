module.exports = {
  super: 'java/lang/Number',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'int',
    },
  },
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
