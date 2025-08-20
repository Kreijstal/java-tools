const Frame = require('../../../../frame');
const { parseDescriptor } = require('../../../../typeParser');
const { ASYNC_METHOD_SENTINEL } = require('../../../../constants');

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
    },
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
