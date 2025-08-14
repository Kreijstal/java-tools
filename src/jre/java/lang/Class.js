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

      const superClassName = classData.classes[0].superClass;
      if (superClassName) {
        const superClassData = jvm.classes[superClassName];
        if (superClassData) {
          getMethodsRecursive({ type: 'java/lang/Class', _classData: superClassData });
        } else if (superClassName === 'java/lang/Object') {
            const objectMethods = [
                { name: 'equals', descriptor: '(Ljava/lang/Object;)Z' },
                { name: 'toString', descriptor: '()Ljava/lang/String;' },
                { name: 'hashCode', descriptor: '()I' },
                { name: 'getClass', descriptor: '()Ljava/lang/Class;' },
                { name: 'notify', descriptor: '()V' },
                { name: 'notifyAll', descriptor: '()V' },
                { name: 'wait', descriptor: '(J)V' },
                { name: 'wait', descriptor: '(JI)V' },
                { name: 'wait', descriptor: '()V' },
            ];
            objectMethods.forEach(method => {
                const key = method.name + method.descriptor;
                if (!allMethods[key]) {
                    allMethods[key] = {
                        type: 'java/lang/reflect/Method',
                        _methodData: { ...method, flags: ['public'], attributes: [{ type: 'code', code: { localsSize: 1, codeItems: [] } }] },
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

    // TODO: handle parameter types
    const method = methods.find(m => m.method.name === methodName);

    if (method) {
      return {
        type: 'java/lang/reflect/Method',
        _methodData: method.method,
        _declaringClass: classObj,
      };
    } else {
      throw new Error(`NoSuchMethodException: ${methodName}`);
    }
  },
};
