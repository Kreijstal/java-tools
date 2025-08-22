const { MethodHandle, CallSite } = require('./');

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
          // Convert boolean values (1/0) to "true"/"false" strings
          if (arg === 1 || arg === 0) {
            result += (arg === 1 ? 'true' : 'false');
          } else {
            result += arg;
          }
        } else {
          result += char;
        }
      }
      return jvm.internString(result);
    }
  },
};
