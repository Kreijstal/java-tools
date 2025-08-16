const Frame = require('../../../../frame');

module.exports = {
  'java/lang/reflect/Method.getName()Ljava/lang/String;': (jvm, methodObj, args) => {
    const methodName = methodObj._methodData.name;
    return jvm.internString(methodName);
  },

  'java/lang/reflect/Method.invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;': async (jvm, methodObj, args) => {
    console.log('Inside Method.js JRE handler for Method.invoke');
    const obj = args[0];
    const methodArgs = args[1];

    const methodData = methodObj._methodData;
    const { name, descriptor, flags } = methodData;
    const isStatic = flags.includes('static');

    const className = methodObj._declaringClass._classData.ast.classes[0].className;
    const method = jvm.findMethodInHierarchy(className, name, descriptor);

    if (method) {
      const newFrame = new Frame(method);
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

      return new Promise((resolve) => {
          thread.isAwaitingReflectiveCall = true;
          thread.reflectiveCallResolver = (ret) => {
              console.log('Executing reflectiveCallResolver in Method.js, ret:', ret);
              resolve(ret);
          };
          thread.callStack.push(newFrame);
      });
    } else {
      throw new Error(`Could not find method ${name}${descriptor} for reflective invocation.`);
    }
  },
};
