module.exports = {
  super: "java/lang/Object",
  staticFields: {
    "TYPE:Ljava/lang/Class;": {
      type: "java/lang/Class",
      isPrimitive: true,
      name: "double",
    },
    "MAX_VALUE:D": 1.7976931348623157e308,
    "MIN_NORMAL:D": 2.2250738585072014e-308,
    "MIN_VALUE:D": 4.9e-324,
    "POSITIVE_INFINITY:D": Number.POSITIVE_INFINITY,
    "NEGATIVE_INFINITY:D": Number.NEGATIVE_INFINITY,
    "NaN:D": Number.NaN,
  },
  staticMethods: {
    "parseDouble(Ljava/lang/String;)D": (jvm, obj, args) => {
      const str = args[0];
      return parseFloat(str);
    },
    "valueOf(D)Ljava/lang/Double;": (jvm, obj, args) => {
      const doubleObj = {
        type: "java/lang/Double",
        value: args[0],
      };

      // Add JavaScript toString method for proper string concatenation
      doubleObj.toString = function () {
        return this.value.toString();
      };

      return doubleObj;
    },
    "isInfinite(D)Z": (jvm, obj, args) => {
      const value = args[0];
      return !isFinite(value) && !isNaN(value) ? 1 : 0;
    },
    "isNaN(D)Z": (jvm, obj, args) => {
      const value = args[0];
      return isNaN(value) ? 1 : 0;
    },
    "isFinite(D)Z": (jvm, obj, args) => {
      const value = args[0];
      return isFinite(value) ? 1 : 0;
    },
  },
  methods: {
    "<init>(D)V": (jvm, obj, args) => {
      obj.value = args[0];

      // Add JavaScript toString method for proper string concatenation
      obj.toString = function () {
        return this.value.toString();
      };
    },
    "doubleValue()D": (jvm, obj, args) => {
      return obj.value;
    },
    "toString()Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(obj.value.toString());
    },
    "getClass()Ljava/lang/Class;": (jvm, obj, args) => {
      return {
        type: "java/lang/Class",
        className: "java.lang.Double",
        getSimpleName: function () {
          return jvm.internString("Double");
        },
      };
    },
  },
};
