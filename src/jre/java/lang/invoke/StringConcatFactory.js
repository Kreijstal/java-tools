const { MethodHandle, CallSite } = require('./');

// Format values according to Java string concatenation rules
function formatJavaValue(arg) {
  if (typeof arg === 'number') {
    // Handle numeric values according to Java rules
    if (Number.isInteger(arg) && arg >= -2147483648 && arg <= 2147483647) {
      // Integer range - format as plain integer
      return String(arg);
    } else if (Number.isInteger(arg)) {
      // Beyond integer range, likely a whole number float/double
      // In Java, whole number floats display as "5.0", doubles as "5.0"
      return arg.toFixed(1);
    } else {
      // Non-integer floating point
      const str = arg.toString();
      // Clean up JavaScript's extra precision for common Java float precision
      if (str.includes('.') && str.length > 10) {
        // Try to match Java's typical float precision (7 significant digits)
        const precise = parseFloat(arg.toPrecision(7));
        return precise.toString();
      }
      return str;
    }
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

      const concatMethodHandle = new MethodHandle(
        'invokestatic',
        {
          className: 'java/lang/invoke/StringConcatFactory',
          methodName: 'concat',
          methodDescriptor: '(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;'
        }
      );

      const callSite = new CallSite(concatMethodHandle.bindTo(recipe));
      return callSite;
    },

    'concat(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;': (jvm, _, args) => {
      const recipe = args[0];
      const dynamicArgs = args[1];

      let result = '';
      let argIndex = 0;
      for (let i = 0; i < recipe.length; i++) {
        const char = recipe.charAt(i);
        if (char === '\u0001') {
          const arg = dynamicArgs[argIndex++];
          result += formatJavaValue(arg);
        } else {
          result += char;
        }
      }
      return jvm.internString(result);
    }
  },
};
