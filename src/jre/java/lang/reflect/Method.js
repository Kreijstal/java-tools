const Frame = require('../../../../core/frame');
const { parseDescriptor } = require('../../../../parsing/typeParser');
const { ASYNC_METHOD_SENTINEL } = require('../../../../core/constants');
const { withThrows } = require('../../../helpers');

// Method.invoke must return boxed objects for primitive-returning methods;
// callers checkcast to the wrapper type (e.g. (Long) m.invoke(...)).
function box(type, value, toStr) {
  const obj = { type, value };
  obj.toString = toStr || function () { return String(this.value); };
  return obj;
}

function boxReflectiveReturn(descriptor, value) {
  if (value === null || value === undefined) return null;
  const retType = descriptor.slice(descriptor.indexOf(')') + 1);
  switch (retType) {
    case 'V': return null;
    case 'J': return box('java/lang/Long', typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value))));
    case 'I': return box('java/lang/Integer', Number(value) | 0);
    case 'S': return box('java/lang/Short', Number(value) | 0);
    case 'B': return box('java/lang/Byte', Number(value) | 0);
    case 'C': return box('java/lang/Character', Number(value) | 0, function () { return String.fromCharCode(this.value); });
    case 'Z': return box('java/lang/Boolean', !!Number(value), function () { return this.value ? 'true' : 'false'; });
    case 'F': return box('java/lang/Float', Number(value));
    case 'D': return box('java/lang/Double', Number(value));
    default: return value;
  }
}

const MODIFIERS = {
  PUBLIC: 0x00000001,
  PRIVATE: 0x00000002,
  PROTECTED: 0x00000004,
  STATIC: 0x00000008,
  FINAL: 0x00000010,
  SYNCHRONIZED: 0x00000020,
  NATIVE: 0x00000100,
  ABSTRACT: 0x00000400,
  STRICT: 0x00000800,
};

module.exports = {
  super: 'java/lang/reflect/AccessibleObject',
  staticFields: {},
  methods: {
    'getExceptionTypes()[Ljava/lang/Class;': () => [],
    'getName()Ljava/lang/String;': (jvm, methodObj, args) => {
      const methodName = methodObj._methodData.name;
      return jvm.internString(methodName);
    },
    'getModifiers()I': (jvm, methodObj, args) => {
      const flags = methodObj._methodData.flags;
      let modifiers = 0;
      if (flags.includes('public')) modifiers |= MODIFIERS.PUBLIC;
      if (flags.includes('protected')) modifiers |= MODIFIERS.PROTECTED;
      if (flags.includes('private')) modifiers |= MODIFIERS.PRIVATE;
      if (flags.includes('static')) modifiers |= MODIFIERS.STATIC;
      if (flags.includes('final')) modifiers |= MODIFIERS.FINAL;
      if (flags.includes('synchronized')) modifiers |= MODIFIERS.SYNCHRONIZED;
      if (flags.includes('native')) modifiers |= MODIFIERS.NATIVE;
      if (flags.includes('abstract')) modifiers |= MODIFIERS.ABSTRACT;
      if (flags.includes('strict')) modifiers |= MODIFIERS.STRICT;
      return modifiers;
    },
    'setAccessible(Z)V': (jvm, methodObj, args) => {
      methodObj.accessible = args[0];
    },
    'invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;': withThrows(async (jvm, methodObj, args) => {
      const methodData = methodObj._methodData;
      const { name, descriptor, flags } = methodData;
      const obj = args[0];
      const methodArgs = args[1] ? args[1] : [];

      const isStatic = flags.includes('static');

      if (!isStatic && obj === null) {
        throw {
          type: 'java/lang/NullPointerException',
          message: `Cannot invoke instance method ${name} on a null object`,
        };
      }

      // For JRE method lookup, use the declaring class for static methods, otherwise use obj.type
      let classNameForLookup;
      if (isStatic) {
        // Use the declaring class for static methods
        const declaringClass = methodObj._declaringClass;
        if (declaringClass && declaringClass._classData && declaringClass._classData.ast) {
          classNameForLookup = declaringClass._classData.ast.classes[0].className;
        }
      } else {
        // Use the object's type for instance methods
        classNameForLookup = obj.type;
      }

      if (classNameForLookup) {
        const jreMethod = jvm._jreFindMethod(classNameForLookup, name, descriptor);
        if (jreMethod) {
          const result = await jreMethod(jvm, obj, methodArgs, jvm.threads[jvm.currentThreadIndex]);
          return boxReflectiveReturn(descriptor, result);
        }
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
      if (methodData.className) {
        newFrame.className = methodData.className; // Add className if available
      }
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
      const callingFrame = thread.callStack.peek();

      thread.isAwaitingReflectiveCall = true;
      // Return bytecodes hand the resolver a concrete JVM value. Keep this
      // synchronous so the fast interpreter cannot resume the caller before
      // its reflected result has been materialized.
      thread.reflectiveCallResolver = (ret) => {
        callingFrame.stack.push(boxReflectiveReturn(descriptor, ret));
      };
      thread.callStack.push(newFrame);

      return ASYNC_METHOD_SENTINEL;
    }, [
      'java/lang/NullPointerException',
      'java/lang/IllegalArgumentException',
      'java/lang/IllegalAccessException',
      'java/lang/reflect/InvocationTargetException',
    ]),
    'isAnnotationPresent(Ljava/lang/Class;)Z': (jvm, methodObj, args) => {
      const annotationClass = args[0];
      const annotations = methodObj._annotations || [];
      
      // Check if annotation of the specified type is present
      return annotations.some(ann => {
        const annotationType = ann.type;
        const annotationClassName = annotationClass._classData ? 
          annotationClass._classData.ast.classes[0].className : 
          annotationClass.className;
        return annotationType === annotationClassName;
      });
    },
    'getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;': (jvm, methodObj, args) => {
      const annotationClass = args[0];
      const annotations = methodObj._annotations || [];
      
      // Find annotation of the specified type
      const annotation = annotations.find(ann => {
        const annotationType = ann.type;
        const annotationClassName = annotationClass._classData ? 
          annotationClass._classData.ast.classes[0].className : 
          annotationClass.className;
        return annotationType === annotationClassName;
      });
      
      if (annotation) {
        // Create annotation proxy object
        return jvm.createAnnotationProxy(annotation);
      }
      
      return null;
    },
  }
};

const methodJre = module.exports;

methodJre.methods['invoke(Ljava/lang/Object;)Ljava/lang/Object;'] = (jvm, methodObj, args, thread) => (
  methodJre.methods['invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;'](jvm, methodObj, [args[0], []], thread)
);

methodJre.methods['invoke(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;'] = (jvm, methodObj, args, thread) => (
  methodJre.methods['invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;'](jvm, methodObj, [args[0], [args[1]]], thread)
);

methodJre.methods['invoke(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;'] = (jvm, methodObj, args, thread) => (
  methodJre.methods['invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;'](jvm, methodObj, [args[0], [args[1], args[2]]], thread)
);
