module.exports = {
  'java/lang/Class.getName()Ljava/lang/String;': (jvm, classObj, args) => {
    const classData = classObj._classData;
    const className = classData.classes[0].className.replace(/\//g, '.');
    return jvm.internString(className);
  },

  'java/lang/Class.getSuperclass()Ljava/lang/Class;': async (jvm, classObj, args) => {
    const classData = classObj._classData;
    const superClassName = classData.classes[0].superClass;
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

  'java/lang/Class.isInterface()Z': (jvm, classObj, args) => {
    const classData = classObj._classData;
    return classData.classes[0].flags.includes('interface');
  },

  'java/lang/Class.getMethods()[Ljava/lang/reflect/Method;': (jvm, classObj, args) => {
    const allMethods = {};

    const getMethodsRecursive = (currentClassObj) => {
      const classData = currentClassObj._classData;
      if (!classData) {
        return;
      }

      classData.classes[0].items
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

      const superClassName = classData.classes[0].superClassName;
      if (superClassName) {
        const superClassData = jvm.classes[superClassName];
        if (superClassData && superClassName !== 'java/lang/Object') {
          getMethodsRecursive({ type: 'java/lang/Class', _classData: superClassData });
        }
        if (superClassName === 'java/lang/Object') {
            const objectMethods = require('./Object.js');
            Object.keys(objectMethods).forEach(methodSignature => {
                const lastDot = methodSignature.lastIndexOf('.');
                const nameAndDescriptor = methodSignature.substring(lastDot + 1);
                const openParen = nameAndDescriptor.indexOf('(');
                const name = nameAndDescriptor.substring(0, openParen);
                const descriptor = nameAndDescriptor.substring(openParen);
                const key = name + descriptor;
                if (!allMethods[key]) {
                    allMethods[key] = {
                        type: 'java/lang/reflect/Method',
                        _methodData: { name, descriptor, flags: ['public'], attributes: [{ type: 'code', code: { localsSize: 1, codeItems: [] } }] },
                        _declaringClass: { type: 'java/lang/Class', _classData: null /* object class data */ },
                    };
                }
            });
        }
      }
    };

    getMethodsRecursive(classObj);
    return Object.values(allMethods);
  },

  'java/lang/Class.getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;': (jvm, classObj, args) => {
    const methodName = args[0];
    const paramTypes = args[1]; // array of class objects

    const classData = classObj._classData;
    const methods = classData.classes[0].items.filter(item => item.type === 'method');

    const getDescriptor = (paramClass) => {
      if (!paramClass) return '';
      const paramClassName = paramClass._classData.classes[0].className;
      // Basic type mapping, can be extended
      switch (paramClassName) {
        case 'int': return 'I';
        case 'long': return 'J';
        case 'double': return 'D';
        case 'float': return 'F';
        case 'char': return 'C';
        case 'short': return 'S';
        case 'byte': return 'B';
        case 'boolean': return 'Z';
        default: return `L${paramClassName};`;
      }
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
};
