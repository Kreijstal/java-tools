const Frame = require('../../../../core/frame');
const { ASYNC_METHOD_SENTINEL } = require('../../../../core/constants');
const { withThrows } = require('../../../helpers');

function classNameFor(classObj) {
  return classObj && (classObj.className ||
    (classObj._classData && (
      classObj._classData.arrayType ||
      classObj._classData.className ||
      (classObj._classData.ast && classObj._classData.ast.classes[0] &&
        classObj._classData.ast.classes[0].className))));
}

function descriptorForClass(classObj) {
  if (classObj && classObj.isPrimitive) {
    const descriptors = {
      void: 'V', boolean: 'Z', byte: 'B', char: 'C', short: 'S',
      int: 'I', long: 'J', float: 'F', double: 'D',
    };
    return descriptors[classObj.name] || null;
  }
  const className = classNameFor(classObj);
  if (!className) return null;
  const normalized = String(className).replace(/\./g, '/');
  return normalized.startsWith('[') ? normalized : `L${normalized};`;
}

function constructorDescriptor(constructorObj) {
  const parameterTypes = constructorObj._parameterTypes || [];
  const parameters = parameterTypes.map(descriptorForClass);
  if (parameters.some((descriptor) => !descriptor)) return null;
  return `(${parameters.join('')})V`;
}

function unboxConstructorArgument(value) {
  if (value && typeof value === 'object' && value.value !== undefined &&
      typeof value.type === 'string' &&
      value.type.startsWith('java/lang/')) {
    return value.value;
  }
  return value;
}

module.exports = {
  super: 'java/lang/reflect/AccessibleObject',
  staticFields: {},
  methods: {
    'newInstance([Ljava/lang/Object;)Ljava/lang/Object;': withThrows(async (
      jvm,
      constructorObj,
      args,
      thread,
    ) => {
      const constructorArgs = args[0] || [];
      if (typeof constructorObj._newInstance === 'function') {
        return constructorObj._newInstance(jvm, constructorArgs);
      }
      const declaringClass = constructorObj._declaringClass;
      const className = classNameFor(declaringClass);
      if (!className) throw { type: 'java/lang/InstantiationException' };
      const normalizedClassName = String(className).replace(/\./g, '/');
      const descriptor = constructorDescriptor(constructorObj);
      if (!descriptor) {
        throw {
          type: 'java/lang/IllegalArgumentException',
          message: 'Could not resolve reflective constructor parameter types',
        };
      }
      const activeThread = thread ||
        jvm.threads[jvm.currentThreadIndex] ||
        jvm.threads[0];
      const newObj = await jvm.createAppletInstance(
        normalizedClassName,
        activeThread,
      );
      const constructor = jvm.findMethod(
        jvm.classes[normalizedClassName],
        '<init>',
        descriptor,
      );
      if (!constructor) {
        throw {
          type: 'java/lang/InstantiationException',
          message: `${normalizedClassName}.${descriptor}`,
        };
      }

      const callingFrame = activeThread.callStack.peek();
      const constructorFrame = new Frame(constructor);
      constructorFrame.className = normalizedClassName;
      constructorFrame.locals[0] = newObj;
      let localIndex = 1;
      for (const argument of constructorArgs) {
        constructorFrame.locals[localIndex++] =
          unboxConstructorArgument(argument);
      }
      activeThread.isAwaitingReflectiveCall = true;
      activeThread.reflectiveCallFrame = constructorFrame;
      activeThread.reflectiveCallResolver = () => {
        callingFrame.stack.push(newObj);
      };
      activeThread.callStack.push(constructorFrame);
      return ASYNC_METHOD_SENTINEL;
    }, [
      'java/lang/InstantiationException',
      'java/lang/IllegalAccessException',
      'java/lang/IllegalArgumentException',
      'java/lang/reflect/InvocationTargetException',
    ]),
    'getDeclaringClass()Ljava/lang/Class;': (jvm, constructorObj) => constructorObj._declaringClass || null,
    'getName()Ljava/lang/String;': (jvm, constructorObj) => {
      const declaringClass = constructorObj._declaringClass;
      const name = declaringClass && (declaringClass.className
        || (declaringClass._classData && declaringClass._classData.ast
          && declaringClass._classData.ast.classes[0].className));
      return jvm.internString(name || '');
    },
  },
};
