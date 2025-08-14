const Frame = require('../../../../frame');

module.exports = {
  'java/lang/reflect/Method.getName': (jvm, methodObj, args) => {
    const methodName = methodObj._methodData.name;
    return jvm.internString(methodName);
  },

  'java/lang/reflect/Method.invoke': (jvm, methodObj, args) => {
    const obj = args[0];
    const methodArgs = args[1];
    const thread = jvm.threads[jvm.currentThreadIndex];

    return new Promise((resolve, reject) => {
      thread.isAwaitingReflectiveCall = true;
      thread.reflectiveCallResolver = resolve;

      const methodData = methodObj._methodData;
      const newFrame = new Frame(methodData);

      let localIndex = 0;
      if (!methodData.flags.includes('static')) {
        newFrame.locals[localIndex++] = obj;
      }
      for (let i = 0; i < methodArgs.length; i++) {
        newFrame.locals[localIndex++] = methodArgs[i];
      }

      thread.callStack.push(newFrame);
    });
  },
};
