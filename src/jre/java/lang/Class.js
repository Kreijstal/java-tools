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
        };
      } else {
        throw {
          type: 'java/lang/NoSuchMethodException',
          message: methodName,
        };
      }
    },
    'isAnnotationPresent(Ljava/lang/Class;)Z': (jvm, classObj, args) => {
      // For now, return false since we don't have full annotation support
      // In a complete implementation, this would check the annotations on the class
      return false;
    },
    'getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;': (jvm, classObj, args) => {
      // Return null since we don't have annotation support yet
      return null;
    },
  }
};
