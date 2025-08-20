module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    'getName()Ljava/lang/String;': (jvm, classObj, args) => {
      const classData = classObj._classData;
      const className = classData.ast.classes[0].className.replace(/\//g, '.');
      return jvm.internString(className);
    },
    'getSimpleName()Ljava/lang/String;': (jvm, classObj, args) => {
      // Handle primitive wrapper classes and other objects that may not have _classData
      if (classObj.className) {
        return jvm.internString(classObj.className.split('.').pop());
      }
      
      const classData = classObj._classData;
      if (classData && classData.ast && classData.ast.classes[0]) {
        const fullName = classData.ast.classes[0].className;
        const simpleName = fullName.split('/').pop().split('$').pop();
        return jvm.internString(simpleName);
      }
      
      // Fallback if we can't determine the class name
      return jvm.internString('Unknown');
    },
    'getSuperclass()Ljava/lang/Class;': async (jvm, classObj, args) => {
      const classData = classObj._classData;
      const superClassName = classData.ast.classes[0].superClassName;
      if (!superClassName) {
        return null;
      }
      const superClassData = await jvm.loadClassByName(superClassName);
      if (!superClassData) {
        return null;
      }
      return {
        type: 'java/lang/Class',
        _classData: superClassData,
      };
    },
    'isInterface()Z': (jvm, classObj, args) => {
      const classData = classObj._classData;
      return classData.ast.classes[0].flags.includes('interface');
    },
    'getMethods()[Ljava/lang/reflect/Method;': (jvm, classObj, args) => {
      const allMethods = {};

      const getMethodsRecursive = (currentClassObj) => {
        const classData = currentClassObj._classData;
        if (!classData || !classData.ast) {
          return;
        }

        // Add methods from the current class
        classData.ast.classes[0].items
          .filter(item => item.type === 'method' && item.method.flags.includes('public'))
          .forEach(methodItem => {
            const key = methodItem.method.name + methodItem.method.descriptor;
            if (!allMethods[key]) {
              allMethods[key] = {
                type: 'java/lang/reflect/Method',
                _methodData: methodItem.method,
                _declaringClass: currentClassObj,
              };
            }
          });

        const superClassName = classData.ast.classes[0].superClassName;
        if (superClassName) {
          const superClassData = jvm.classes[superClassName];
          if (superClassData) {
            getMethodsRecursive({ type: 'java/lang/Class', _classData: superClassData });
          }
        }
      };

      getMethodsRecursive(classObj);

      // Manually add java.lang.Object methods if they haven't been added by a subclass
      const objectMethods = require('./Object.js');
      
      // Define access modifiers for Object methods
      const objectMethodAccessModifiers = {
        'getClass': ['public', 'final', 'native'],
        'hashCode': ['public', 'native'],
        'equals': ['public'],
        'toString': ['public'],
        'clone': ['protected', 'native'],
        'wait': ['public', 'final', 'native'],
        'notify': ['public', 'final', 'native'],
        'notifyAll': ['public', 'final', 'native'],
      };
      
      Object.keys(objectMethods.methods).forEach(methodSignature => {
          const openParen = methodSignature.indexOf('(');
          const name = methodSignature.substring(0, openParen);
          const descriptor = methodSignature.substring(openParen);
          const key = name + descriptor;
          
          // Only add public methods to getMethods() result
          const flags = objectMethodAccessModifiers[name] || ['public'];
          if (flags.includes('public') && !allMethods[key]) {
              allMethods[key] = {
                  type: 'java/lang/reflect/Method',
                  _methodData: { name, descriptor, flags, attributes: [{ type: 'code', code: { localsSize: 1, codeItems: [] } }] },
                  _declaringClass: { type: 'java/lang/Class', _classData: jvm.classes['java/lang/Object'] },
              };
          }
      });

      return Object.values(allMethods);
    },
    'getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;': (jvm, classObj, args) => {
      const methodName = args[0];
      const paramTypes = args[1]; // array of class objects

      const classData = classObj._classData;
      const methods = classData.ast.classes[0].items.filter(item => item.type === 'method');

      const getDescriptor = (paramClass) => {
        if (!paramClass) return '';
        if (paramClass.isPrimitive) {
          switch (paramClass.name) {
            case 'int': return 'I';
            case 'long': return 'J';
            case 'double': return 'D';
            case 'float': return 'F';
            case 'char': return 'C';
            case 'short': return 'S';
            case 'byte': return 'B';
            case 'boolean': return 'Z';
            default: throw new Error(`Unknown primitive type: ${paramClass.name}`);
          }
        }
        const paramClassName = paramClass._classData.ast.classes[0].className;
        return `L${paramClassName};`;
      };

      const targetDescriptor = `(${paramTypes.map(getDescriptor).join('')})`;
      const method = methods.find(m => {
        const d = m.method.descriptor;
        return m.method.name === methodName && d.substring(0, d.indexOf(')') + 1) === targetDescriptor;
      });

      if (method) {
        return {
          type: 'java/lang/reflect/Method',
          _methodData: method.method,
          _declaringClass: classObj,
          _annotations: method.method.annotations || [],
        };
      } else {
        throw {
          type: 'java/lang/NoSuchMethodException',
          message: methodName,
        };
      }
    },
    'getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;': (jvm, classObj, args) => {
      const methodNameObj = args[0];
      const paramTypes = args[1]; // array of class objects

      // Extract the actual string value from JVM string object
      let methodName;
      if (typeof methodNameObj === 'string') {
        methodName = methodNameObj;
      } else if (methodNameObj && methodNameObj.value) {
        methodName = methodNameObj.value;
      } else if (methodNameObj && typeof methodNameObj.toString === 'function') {
        methodName = methodNameObj.toString();
      } else {
        methodName = String(methodNameObj);
      }

      const classData = classObj._classData;
      const methods = classData.ast.classes[0].items.filter(item => item.type === 'method');

      const getDescriptor = (paramClass) => {
        if (!paramClass) return '';
        if (paramClass.isPrimitive) {
          switch (paramClass.name) {
            case 'int': return 'I';
            case 'long': return 'J';
            case 'double': return 'D';
            case 'float': return 'F';
            case 'char': return 'C';
            case 'short': return 'S';
            case 'byte': return 'B';
            case 'boolean': return 'Z';
            default: throw new Error(`Unknown primitive type: ${paramClass.name}`);
          }
        }
        const paramClassName = paramClass._classData.ast.classes[0].className;
        return `L${paramClassName};`;
      };

      const targetDescriptor = `(${paramTypes.map(getDescriptor).join('')})`;
      
      const method = methods.find(m => {
        const d = m.method.descriptor;
        const methodDescriptor = d.substring(0, d.indexOf(')') + 1);
        return m.method.name === methodName && methodDescriptor === targetDescriptor;
      });

      if (method) {
        return {
          type: 'java/lang/reflect/Method',
          _methodData: method.method,
          _declaringClass: classObj,
          _annotations: method.method.annotations || [],
        };
      } else {
        throw {
          type: 'java/lang/NoSuchMethodException',
          message: methodName,
        };
      }
    },
    'getDeclaredField(Ljava/lang/String;)Ljava/lang/reflect/Field;': (jvm, classObj, args) => {
      const fieldNameObj = args[0];
      
      // Extract the actual string value from JVM string object
      let fieldName;
      if (typeof fieldNameObj === 'string') {
        fieldName = fieldNameObj;
      } else if (fieldNameObj && fieldNameObj.value) {
        fieldName = fieldNameObj.value;
      } else if (fieldNameObj && typeof fieldNameObj.toString === 'function') {
        fieldName = fieldNameObj.toString();
      } else {
        fieldName = String(fieldNameObj);
      }
      
      const classData = classObj._classData;
      
      // Find the field in the class
      const field = classData.ast.classes[0].items.find(item => 
        item.type === 'field' && item.field.name === fieldName
      );
      
      if (field) {
        return {
          type: 'java/lang/reflect/Field',
          _fieldData: field.field,
          _declaringClass: classObj,
          _annotations: field.field.annotations || [],
        };
      } else {
        throw {
          type: 'java/lang/NoSuchFieldException',
          message: fieldName,
        };
      }
    },
    'getDeclaredFields()[Ljava/lang/reflect/Field;': (jvm, classObj, args) => {
      const classData = classObj._classData;
      const fields = classData.ast.classes[0].items.filter(item => item.type === 'field');
      
      return fields.map(fieldItem => ({
        type: 'java/lang/reflect/Field',
        _fieldData: fieldItem.field,
        _declaringClass: classObj,
        _annotations: fieldItem.field.annotations || [],
      }));
    },
    'isAnnotationPresent(Ljava/lang/Class;)Z': (jvm, classObj, args) => {
      const annotationClass = args[0];
      const classData = classObj._classData;
      const annotations = (classData.ast && classData.ast.annotations) ? classData.ast.annotations : [];
      
      // Check if annotation of the specified type is present
      return annotations.some(ann => {
        const annotationType = ann.type;
        const annotationClassName = annotationClass._classData ? 
          annotationClass._classData.ast.classes[0].className : 
          annotationClass.className;
        return annotationType === annotationClassName;
      });
    },
    'getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;': (jvm, classObj, args) => {
      const annotationClass = args[0];
      const classData = classObj._classData;
      const annotations = (classData.ast && classData.ast.annotations) ? classData.ast.annotations : [];
      
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
