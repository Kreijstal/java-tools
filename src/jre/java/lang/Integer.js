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
    'toBinaryString(I)Ljava/lang/String;': (jvm, obj, args) => {
      const intValue = args[0];
      // Use unsigned right shift to get the 32-bit two's complement representation
      const binaryString = (intValue >>> 0).toString(2);
      return jvm.internString(binaryString);
    },
    'toString(I)Ljava/lang/String;': (jvm, obj, args) => {
      const intValue = args[0];
      // Per spec, this should be a new string, not an interned one.
      return jvm.newString(intValue.toString());
    },
    'parseInt(Ljava/lang/String;)I': (jvm, obj, args) => {
      const str = args[0];
      const stringValue = typeof str === 'string' ? str : (str ? str.value : '0');
      const result = parseInt(stringValue, 10);
      if (isNaN(result)) {
        // In real Java this would throw NumberFormatException
        return 0;
      }
      return result;
    },
    'toHexString(I)Ljava/lang/String;': (jvm, obj, args) => {
      const intValue = args[0];
      const hexString = (intValue >>> 0).toString(16);
      return jvm.newString(hexString);
    },
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
      // Per spec, this should be a new string, not an interned one.
      return jvm.newString(obj.value.toString());
    },
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      return {
        type: 'java/lang/Class',
        className: 'java.lang.Integer',
        getSimpleName: function() {
          return jvm.internString('Integer');
        }
      };
    },
  },
};
