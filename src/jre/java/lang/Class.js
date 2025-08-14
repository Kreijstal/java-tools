module.exports = {
  'java/lang/Class.getName': (jvm, classObj, args) => {
    const classData = classObj._classData;
    const className = classData.classes[0].className.replace(/\//g, '.');
    return jvm.internString(className);
  },

  'java/lang/Class.getSuperclass': async (jvm, classObj, args) => {
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

  'java/lang/Class.isInterface': (jvm, classObj, args) => {
    const classData = classObj._classData;
    return classData.classes[0].flags.includes('interface');
  },

  'java/lang/Class.getMethods': (jvm, classObj, args) => {
    // TODO: Handle inherited methods
    const classData = classObj._classData;
    const methods = classData.classes[0].items
      .filter(item => item.type === 'method' && item.method.flags.includes('public'))
      .map(methodItem => ({
        type: 'java/lang/reflect/Method',
        _methodData: methodItem.method,
        _declaringClass: classObj,
      }));
    return methods;
  },
};
