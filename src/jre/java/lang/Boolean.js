const BOOLEAN_TRUE = { type: 'java/lang/Boolean', value: true };
const BOOLEAN_FALSE = { type: 'java/lang/Boolean', value: false };

BOOLEAN_TRUE.toString = function() { return 'true'; };
BOOLEAN_FALSE.toString = function() { return 'false'; };

module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'boolean',
    },
    'TRUE:Ljava/lang/Boolean;': BOOLEAN_TRUE,
    'FALSE:Ljava/lang/Boolean;': BOOLEAN_FALSE,
  },
  staticMethods: {
    'toString(Z)Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(args[0] ? 'true' : 'false');
    },
    'valueOf(Z)Ljava/lang/Boolean;': (jvm, obj, args) => {
      return args[0] ? BOOLEAN_TRUE : BOOLEAN_FALSE;
    },
    'valueOf(Ljava/lang/String;)Ljava/lang/Boolean;': (jvm, obj, args) => {
      const str = args[0];
      // Handle both string objects and primitive strings
      const stringValue = (typeof str === 'string') ? str : (str && str.value ? str.value : str);
      const boolValue = stringValue ? stringValue.toLowerCase() === 'true' : false;
      
      return boolValue ? BOOLEAN_TRUE : BOOLEAN_FALSE;
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
