module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'boolean',
    },
    'TRUE:Ljava/lang/Boolean;': {
      type: 'java/lang/Boolean',
      value: true,
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
    'valueOf(Ljava/lang/String;)Ljava/lang/Boolean;': (jvm, obj, args) => {
      const str = args[0];
      // Handle both string objects and primitive strings
      const stringValue = (typeof str === 'string') ? str : (str && str.value ? str.value : str);
      const boolValue = stringValue ? stringValue.toLowerCase() === 'true' : false;
      
      const booleanObj = {
        type: 'java/lang/Boolean',
        value: boolValue,
      };
      
      booleanObj.toString = function() {
        return this.value ? 'true' : 'false';
      };
      
      return booleanObj;
    },
    'parseBoolean(Ljava/lang/String;)Z': (jvm, obj, args) => {
      const str = args[0];
      if (!str) return false;
      // Handle both string objects and primitive strings
      const stringValue = (typeof str === 'string') ? str : (str && str.value ? str.value : str);
      if (!stringValue) return false;
      return stringValue.toLowerCase() === 'true';
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
