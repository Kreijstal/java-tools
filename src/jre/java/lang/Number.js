module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {},
  methods: {
    'intValue()I': (jvm, obj, args) => {
      // Abstract method - should be overridden
      return obj.value || 0;
    },
    'longValue()J': (jvm, obj, args) => {
      // Abstract method - should be overridden
      return BigInt(obj.value || 0);
    },
    'floatValue()F': (jvm, obj, args) => {
      // Abstract method - should be overridden
      return parseFloat(obj.value || 0);
    },
    'doubleValue()D': (jvm, obj, args) => {
      // Abstract method - should be overridden
      return parseFloat(obj.value || 0);
    }
  }
};