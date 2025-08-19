module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'double',
    },
  },
  staticMethods: {
    'valueOf(D)Ljava/lang/Double;': (jvm, obj, args) => {
      const doubleObj = {
        type: 'java/lang/Double',
        value: args[0],
      };
      
      // Add JavaScript toString method for proper string concatenation
      doubleObj.toString = function() {
        return this.value.toString();
      };
      
      return doubleObj;
    },
  },
  methods: {
    '<init>(D)V': (jvm, obj, args) => {
      obj.value = args[0];
      
      // Add JavaScript toString method for proper string concatenation
      obj.toString = function() {
        return this.value.toString();
      };
    },
    'doubleValue()D': (jvm, obj, args) => {
      return obj.value;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.value.toString());
    },
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      return {
        type: 'java/lang/Class',
        className: 'java.lang.Double',
        getSimpleName: function() {
          return jvm.internString('Double');
        }
      };
    },
  },
};
