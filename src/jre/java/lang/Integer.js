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
      const integerObj = {
        type: 'java/lang/Integer',
        value: args[0],
      };
      
      // Add JavaScript toString method for proper string concatenation
      integerObj.toString = function() {
        return this.value.toString();
      };
      
      return integerObj;
    },
    'intValue()I': (jvm, obj, args) => {
      return obj.value;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.value.toString());
    },
  },
};
