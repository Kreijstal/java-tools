module.exports = {
  super: 'java/lang/Number',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'int',
    },
  },
  staticMethods: {
    'valueOf(I)Ljava/lang/Integer;': (jvm, obj, args) => {
      const integerObj = {
        type: 'java/lang/Integer',
        value: args[0],
      };
      
      // Add JavaScript toString method for proper string concatenation
      integerObj.toString = function() {
        if (this.value === undefined || this.value === null) {
          console.error('Integer toString called with undefined/null value:', this);
          return 'null';
        }
        return this.value.toString();
      };
      
      return integerObj;
    },
  },
  methods: {
    '<init>(I)V': (jvm, obj, args) => {
      obj.value = args[0];
      
      // Add JavaScript toString method for proper string concatenation
      obj.toString = function() {
        return this.value.toString();
      };
    },
    'intValue()I': (jvm, obj, args) => {
      return obj.value;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.value.toString());
    },
  },
};
