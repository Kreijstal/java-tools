module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {
    'valueOf(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;': (jvm, obj, args) => {
      const clazz = args[0];
      const name = args[1];
      const nameStr = name.toString();

      const enumClassName = clazz._classData ? clazz._classData.ast.classes[0].className : 'UnknownEnum';

      const classData = jvm.classes[enumClassName];
      if (classData && classData.staticFields) {
        // The name of an enum constant is stored in the 'name' property of the enum object itself.
        for (const value of classData.staticFields.values()) {
          if (value && value.type === enumClassName && value.name === nameStr) {
            return value;
          }
        }
      }

      throw {
        type: 'java/lang/IllegalArgumentException',
        message: `No enum constant ${enumClassName}.${nameStr}`
      };
    },
  },
  methods: {
    '<init>(Ljava/lang/String;I)V': (jvm, obj, args) => {
      // Constructor for enum: name and ordinal
      obj.name = args[0];
      obj.ordinal = args[1];
      // Override the native toString method for easier string concatenation
      obj.toString = () => {
        if (obj.name && typeof obj.name === 'object' && obj.name.value) {
          return obj.name.value;
        }
        return obj.name || 'UNKNOWN';
      };
    },
    'name()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.name || jvm.internString('UNKNOWN');
    },
    'ordinal()I': (jvm, obj, args) => {
      return obj.ordinal || 0;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {

      // The 'name' property is set in the constructor. It should be a primitive string.
      return jvm.internString(obj.name || 'UNKNOWN');
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const other = args[0];
      // For enums, equals is the same as ==
      return obj === other ? 1 : 0;
    },
    'hashCode()I': (jvm, obj, args) => {
      return obj.hashCode || 0;
    },
    'compareTo(Ljava/lang/Enum;)I': (jvm, obj, args) => {
      const other = args[0];
      const thisOrdinal = obj.ordinal || 0;
      const otherOrdinal = other.ordinal || 0;
      return thisOrdinal - otherOrdinal;
    },
    'compareTo(Ljava/lang/Object;)I': (jvm, obj, args) => {
      // Delegate to the typed version
      return module.exports.methods['compareTo(Ljava/lang/Enum;)I'](jvm, obj, args);
    },
    'getDeclaringClass()Ljava/lang/Class;': (jvm, obj, args) => {
      const className = obj.type;
      const classData = jvm.classes[className];
      return {
        type: 'java/lang/Class',
        _classData: classData,
      };
    },
  },
};