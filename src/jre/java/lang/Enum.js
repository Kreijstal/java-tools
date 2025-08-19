module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {
    'valueOf(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;': (jvm, obj, args) => {
      const clazz = args[0];
      const name = args[1];
      
      // Get the enum class name from the Class object
      const enumClassName = clazz._classData ? clazz._classData.name : 'UnknownEnum';
      
      // Look for the enum constant in the class's static fields
      const classData = jvm.classes[enumClassName];
      if (classData && classData.staticFields) {
        for (const [fieldKey, value] of classData.staticFields) {
          if (fieldKey.startsWith(name + ':') && value && value.name === name) {
            return value;
          }
        }
      }
      
      // If not found, throw IllegalArgumentException
      throw {
        type: 'java/lang/IllegalArgumentException',
        message: `No enum constant ${enumClassName}.${name}`
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
      // This is the Java toString() method, which should return a Java String object
      return obj.name || jvm.internString('UNKNOWN');
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