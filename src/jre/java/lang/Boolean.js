module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'boolean',
    },
  },
  staticMethods: {
    'valueOf(Z)Ljava/lang/Boolean;': (jvm, obj, args) => {
      const booleanObj = {
        type: 'java/lang/Boolean',
        value: args[0],
      };
      
      // Add JavaScript toString method for proper string concatenation
      booleanObj.toString = function() {
        return this.value ? 'true' : 'false';
      };
      
      return booleanObj;
    },
  },
  methods: {
    '<init>(Z)V': (jvm, obj, args) => {
      obj.value = args[0];
      
      // Add JavaScript toString method for proper string concatenation
      obj.toString = function() {
        return this.value ? 'true' : 'false';
      };
    },
    'booleanValue()Z': (jvm, obj, args) => {
      return obj.value;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.value ? 'true' : 'false');
    },
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      return {
        type: 'java/lang/Class',
        className: 'java.lang.Boolean',
        getSimpleName: function() {
          return jvm.internString('Boolean');
        }
      };
    },
  },
};
