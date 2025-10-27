module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'forName(Ljava/lang/String;)Ljava/lang/Class;': async (jvm, classObj, args) => {
      const classNameWithDots = args[0];
      const classNameWithSlashes = classNameWithDots.replace(/\./g, '/');
      return await jvm.getClassObject(classNameWithSlashes);
    },
  },
  methods: {
    'getFields()[Ljava/lang/reflect/Field;': (jvm, classObj, args) => {
      return [];
    },
    'getField(Ljava/lang/String;)Ljava/lang/reflect/Field;': async (jvm, classObj, args) => {
      const fieldNameObj = args[0];

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

      const visited = new Set();
      const queue = [];

      const enqueueClassData = (classData) => {
        if (
          !classData ||
          !classData.ast ||
          !classData.ast.classes ||
          !classData.ast.classes[0]
        ) {
          return;
        }

        const className = classData.ast.classes[0].className;
        if (!visited.has(className)) {
          queue.push({ classData, className });
        }
      };

      enqueueClassData(classObj._classData);

      while (queue.length > 0) {
        const { classData, className } = queue.shift();
        if (visited.has(className)) {
          continue;
        }
        visited.add(className);

        const classItems = (classData.ast.classes[0] && classData.ast.classes[0].items) || [];
        const fieldItem = classItems.find(
          (item) =>
            item.type === 'field' &&
            item.field &&
            item.field.name === fieldName &&
            item.field.flags &&
            item.field.flags.includes('public')
        );

        if (fieldItem) {
          const declaringClassObj =
            classObj._classData &&
            classObj._classData.ast &&
            classObj._classData.ast.classes &&
            classObj._classData.ast.classes[0] &&
            classObj._classData.ast.classes[0].className === className
              ? classObj
              : await jvm.getClassObject(className);

          return {
            type: 'java/lang/reflect/Field',
            _fieldData: fieldItem.field,
            _declaringClass: declaringClassObj,
            _annotations: fieldItem.field.annotations || [],
          };
        }

        const { superClassName, interfaces = [] } = classData.ast.classes[0];

        if (superClassName) {
          try {
            const superClassData = await jvm.loadClassByName(superClassName);
            enqueueClassData(superClassData);
          } catch (e) {
            // Ignore classes that cannot be loaded
          }
        }

        if (interfaces.length) {
          for (const ifaceName of interfaces) {
            try {
              const interfaceData = await jvm.loadClassByName(ifaceName);
              enqueueClassData(interfaceData);
            } catch (e) {
              // Ignore interfaces that cannot be loaded
            }
          }
        }
      }

      throw {
        type: 'java/lang/NoSuchFieldException',
        message: fieldName,
      };
    },
    'getName()Ljava/lang/String;': (jvm, classObj, args) => {
      // Handle primitive class objects
      if (classObj.isPrimitive && classObj.name) {
        return jvm.internString(classObj.name);
      }

      const classData = classObj._classData;
      if (!classData || !classData.ast) {
        if (classObj.type) {
          return jvm.internString(classObj.type.replace(/\//g, '.'));
        }
        return jvm.internString("java.lang.Class");
      }

      const className = classData.ast.classes[0].className.replace(/\//g, '.');
      return jvm.internString(className);
    },
    'getSimpleName()Ljava/lang/String;': (jvm, classObj, args) => {
      if (classObj.className) {
        return jvm.internString(classObj.className.split('.').pop());
      }
      
      const classData = classObj._classData;
      if (classData && classData.ast && classData.ast.classes[0]) {
        const fullName = classData.ast.classes[0].className;
        const simpleName = fullName.split('/').pop().split('$').pop();
        return jvm.internString(simpleName);
      }
      
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
    'isPrimitive()Z': (jvm, classObj, args) => {
      // Check if this is a primitive type class
      return classObj.isPrimitive ? 1 : 0;
    },
    'isArray()Z': (jvm, classObj, args) => {
      // Check if this is an array class
      const classData = classObj._classData;
      return classData && classData.isArray ? 1 : 0;
    },
    'getMethods()[Ljava/lang/reflect/Method;': (jvm, classObj, args) => {
      const allMethods = {};

      const getMethodsRecursive = (currentClassObj) => {
        const classData = currentClassObj._classData;
        if (!classData || !classData.ast) {
          return;
        }

        classData.ast.classes[0].items
          .filter(item => item.type === 'method' && item.method.flags.includes('public') && item.method.name !== '<init>')
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

      // Special case for String, which is a native-implemented class
      if (classObj._classData.ast.classes[0].className === 'java/lang/String') {
        const stringMethods = require('./String.js');
        Object.keys(stringMethods.methods).forEach(methodSignature => {
          const openParen = methodSignature.indexOf('(');
          const name = methodSignature.substring(0, openParen);
          const descriptor = methodSignature.substring(openParen);
          const key = name + descriptor;
          if (!allMethods[key]) {
            allMethods[key] = {
              type: 'java/lang/reflect/Method',
              _methodData: { name, descriptor, flags: ['public'] },
              _declaringClass: classObj,
            };
          }
        });
      }

      const objectMethods = require('./Object.js');
      
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
          
          const flags = objectMethodAccessModifiers[name] || ['public'];
          if (flags.includes('public') && !allMethods[key] && name !== '<init>') {
              allMethods[key] = {
                  type: 'java/lang/reflect/Method',
                  _methodData: { name, descriptor, flags, attributes: [] },
                  _declaringClass: { type: 'java/lang/Class', _classData: jvm.classes['java/lang/Object'] },
              };
          }
      });

      return Object.values(allMethods);
    },
    'getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;': async (jvm, classObj, args) => {
      const methodName = String(args[0]);
      const paramTypes = args[1];

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

      let currentClass = classObj._classData;
      while (currentClass) {
        const methods = currentClass.ast.classes[0].items.filter(item => item.type === 'method');
        const method = methods.find(m => {
            const d = m.method.descriptor;
            const sub = d.substring(0, d.indexOf(')') + 1);
            return m.method.name === methodName && sub === targetDescriptor && m.method.flags.includes('public');
        });

        if (method) {
            return {
            type: 'java/lang/reflect/Method',
            _methodData: method.method,
            _declaringClass: { type: 'java/lang/Class', _classData: currentClass },
            _annotations: method.method.annotations || [],
            };
        }

        const superClassName = currentClass.ast.classes[0].superClassName;
        if (superClassName) {
            currentClass = await jvm.loadClassByName(superClassName);
        } else {
            currentClass = null;
        }
      }

      throw {
        type: 'java/lang/NoSuchMethodException',
        message: methodName,
      };
    },
    'getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;': (jvm, classObj, args) => {
      const methodNameObj = args[0];
      const paramTypes = args[1];

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
      
      const annotation = annotations.find(ann => {
        const annotationType = ann.type;
        const annotationClassName = annotationClass._classData ? 
          annotationClass._classData.ast.classes[0].className : 
          annotationClass.className;
        return annotationType === annotationClassName;
      });
      
      if (annotation) {
        return jvm.createAnnotationProxy(annotation);
      }
      
      return null;
    },
    'newInstance()Ljava/lang/Object;': (jvm, classObj, args) => {
      const classData = classObj._classData;
      const className = classData.ast.classes[0].className;
      const newObj = jvm.newObject(className);
      const constructor = jvm.findMethod(className, '<init>()V');
      if (constructor) {
        jvm.runMethod(constructor, [newObj]);
      }
      return newObj;
    },
    'getClassLoader()Ljava/lang/ClassLoader;': (jvm, classObj, args) => {
      // Return null to indicate the bootstrap class loader
      return null;
    }
  }
};
