const Frame = require('../../../../frame');
const { parseDescriptor } = require('../../../../typeParser');

module.exports = {
  super: 'java/lang/reflect/AccessibleObject',
  staticFields: {},
  methods: {
    'getName()Ljava/lang/String;': (jvm, methodObj, args) => {
      const methodName = methodObj._methodData.name;
      return jvm.internString(methodName);
    },
    'invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;': async (jvm, methodObj, args) => {
      const methodData = methodObj._methodData;
      const { name, descriptor, flags } = methodData;
      const obj = args[0];
      const methodArgs = args[1];

      const isStatic = flags.includes('static');

      if (!isStatic && obj === null) {
        throw {
          type: 'java/lang/NullPointerException',
          message: `Cannot invoke instance method ${name} on a null object`,
        };
      }

      const { params } = parseDescriptor(descriptor);
      const numArgs = methodArgs ? methodArgs.length : 0;

      if (params.length !== numArgs) {
        throw {
          type: 'java/lang/IllegalArgumentException',
          message: `argument type mismatch: expected ${params.length} but got ${numArgs}`,
        };
      }

      const newFrame = new Frame(methodData);
      let localIndex = 0;
      if (!isStatic) {
        newFrame.locals[localIndex++] = obj;
      }
      if (methodArgs) {
        for (const arg of methodArgs) {
          newFrame.locals[localIndex++] = arg;
        }
      }

      const thread = jvm.threads[jvm.currentThreadIndex];

      jvm.pendingAsyncOperations++;
      return new Promise((resolve) => {
        thread.isAwaitingReflectiveCall = true;
        thread.reflectiveCallResolver = (ret) => {
          jvm.pendingAsyncOperations--;
          resolve(ret);
        };
        thread.callStack.push(newFrame);
      });
    },
  }
};
