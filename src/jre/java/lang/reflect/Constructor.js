const { withThrows } = require('../../../helpers');

module.exports = {
  super: 'java/lang/reflect/AccessibleObject',
  staticFields: {},
  methods: {
    'newInstance([Ljava/lang/Object;)Ljava/lang/Object;': withThrows((jvm, constructorObj, args) => {
      const constructorArgs = args[0] || [];
      if (typeof constructorObj._newInstance === 'function') {
        return constructorObj._newInstance(jvm, constructorArgs);
      }
      const declaringClass = constructorObj._declaringClass;
      const className = declaringClass && (declaringClass.className
        || (declaringClass._classData && declaringClass._classData.ast
          && declaringClass._classData.ast.classes[0].className));
      if (!className) throw { type: 'java/lang/InstantiationException' };
      return { type: String(className).replace(/\./g, '/'), constructorArgs };
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
