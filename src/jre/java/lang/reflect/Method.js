const Frame = require('../../../../frame');
const { parseDescriptor } = require('../../../../typeParser');
const { ASYNC_METHOD_SENTINEL } = require('../../../../constants');
const { withThrows } = require('../../../helpers');

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
          const result = jreMethod(jvm, obj, methodArgs, jvm.threads[jvm.currentThreadIndex]);
          return result;
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
      thread.reflectiveCallResolver = async (ret) => {
        const finalRet = await ret;
        callingFrame.stack.push(finalRet);
      };
      thread.callStack.push(newFrame);

      return ASYNC_METHOD_SENTINEL;
    }, ['java/lang/NullPointerException', 'java/lang/IllegalArgumentException']),
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
