const { MethodHandle, CallSite } = require('./');

// Format values according to Java string concatenation rules with type information
function formatJavaValueByType(arg, paramType) {
  if (paramType === 'float') {
    // Float type - format whole numbers with .0 suffix, limited precision
    const num = extractNumericValue(arg);
    if (Math.abs(num - Math.round(num)) < 1e-6) {
      return Math.round(num) + '.0';
    }
    // For float precision, convert to 32-bit float like Java does
    // Java floats have ~7 decimal digits of precision
    const float32 = new Float32Array(1);
    float32[0] = num;
    const javaFloat = float32[0];
    
    // Format with appropriate precision for Java float display
    const str = javaFloat.toString();
    if (str.includes('.') && str.length > 10) {
      // For very long decimal representation, round to Java float precision
      // Use toPrecision(8) to match Java's float string representation
      return parseFloat(javaFloat.toPrecision(8)).toString();
    }
    return str;
  } else if (paramType === 'double') {
    // Double type - format whole numbers with .0 suffix
    const num = extractNumericValue(arg);
    if (Math.abs(num - Math.round(num)) < 1e-10) {
      return Math.round(num) + '.0';
    }
    return num.toString();
  } else if (paramType === 'int') {
    // Integer type - no .0 suffix
    return String(extractNumericValue(arg));
  } else if (paramType === 'long') {
    // Long type - no .0 suffix
    if (typeof arg === 'bigint') {
      return String(arg);
    }
    return String(extractNumericValue(arg));
  } else if (paramType === 'java.lang.String') {
    // String type
    if (arg && typeof arg === 'object' && arg.value !== undefined) {
      return String(arg.value);
    }
    return String(arg);
  } else if (typeof arg === 'number') {
    // Default numeric formatting (fallback)
    return String(arg);
  } else if (typeof arg === 'bigint') {
    return String(arg);
  } else {
    return String(arg);
  }
}

function extractNumericValue(value) {
  if (typeof value === 'object' && value !== null && typeof value.value === 'number') {
    return value.value;
  }
  return value;
}

// Legacy function for backward compatibility (without type information)
function formatJavaValue(arg) {
  if (typeof arg === 'number') {
    return String(arg);
  } else if (typeof arg === 'bigint') {
    return String(arg);
  } else {
    return String(arg);
  }
}

module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    'makeConcatWithConstants(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/invoke/CallSite;': (jvm, _, args) => {
      const recipe = args[3];
      const methodType = args[2];

      const concatMethodHandle = new MethodHandle(
        'invokestatic',
        {
          className: 'java/lang/invoke/StringConcatFactory',
          methodName: 'concat',
          methodDescriptor: '(Ljava/lang/String;Ljava/lang/invoke/MethodType;[Ljava/lang/Object;)Ljava/lang/String;'
        }
      );

      const callSite = new CallSite(concatMethodHandle.bindTo(recipe).bindTo(methodType));
      return callSite;
    },

    'concat(Ljava/lang/String;Ljava/lang/invoke/MethodType;[Ljava/lang/Object;)Ljava/lang/String;': (jvm, _, args) => {
      const recipe = args[0];
      const methodType = args[1];
      const dynamicArgs = args[2];

      // Extract parameter types from method type
      const paramTypes = methodType && methodType.parameterTypes ? methodType.parameterTypes : [];

      let result = '';
      let argIndex = 0;
      for (let i = 0; i < recipe.length; i++) {
        const char = recipe.charAt(i);
        if (char === '\u0001') {
          const arg = dynamicArgs[argIndex];
          const paramType = paramTypes[argIndex];
          
          // Use type-aware formatting if we have type information
          if (paramType) {
            result += formatJavaValueByType(arg, paramType);
          } else {
            // Fallback to generic formatting
            result += formatJavaValue(arg);
          }
          argIndex++;
        } else {
          result += char;
        }
      }
      return jvm.internString(result);
    }
  },
};
