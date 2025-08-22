module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'float',
    },
  },
  staticMethods: {
    'valueOf(F)Ljava/lang/Float;': (jvm, obj, args) => {
      const floatObj = {
        type: 'java/lang/Float',
        value: args[0],
      };

      floatObj.toString = function() {
        return this.value.toString();
      };

      return floatObj;
    },
  },
  methods: {
    '<init>(F)V': (jvm, obj, args) => {
      obj.value = args[0];

      obj.toString = function() {
        return this.value.toString();
      };
    },
    'floatValue()F': (jvm, obj, args) => {
      return obj.value;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.value.toString());
    },
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      return {
        type: 'java/lang/Class',
        className: 'java/lang/Float',
        getSimpleName: function() {
          return jvm.internString('Float');
        }
      };
    },
  },
};
