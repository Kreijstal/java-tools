const { MethodHandle } = require('./index');
const { getClassName, classToDescriptor } = require('/app/src/jre/utils');

module.exports = {
  super: 'java/lang/Object',
  methods: {
    'findStatic(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/MethodHandle;': (jvm, lookup, args) => {
      const clazz = args[0];
      const name = args[1];
      const type = args[2];
      const reference = {
        className: getClassName(clazz).replace(/\./g, '/'),
        nameAndType: {
          name: name.value,
          descriptor: type.toDescriptor(),
        },
      };
      return new MethodHandle('invokeStatic', reference, type);
    },
    'findVirtual(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/MethodHandle;': (jvm, lookup, args) => {
      const clazz = args[0];
      const name = args[1];
      const type = args[2];
      const reference = {
        className: getClassName(clazz).replace(/\./g, '/'),
        nameAndType: {
          name: name.value,
          descriptor: type.toDescriptor(),
        },
      };
      return new MethodHandle('invokeVirtual', reference, type);
    },
    'findGetter(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;': (jvm, lookup, args) => {
      const clazz = args[0];
      const name = args[1];
      const type = args[2];
      const reference = {
        className: getClassName(clazz).replace(/\./g, '/'),
        nameAndType: {
          name: name.value,
          descriptor: classToDescriptor(type),
        },
      };
      return new MethodHandle('getField', reference, type);
    },
    'findSetter(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;': (jvm, lookup, args) => {
      const clazz = args[0];
      const name = args[1];
      const type = args[2];
      const reference = {
        className: getClassName(clazz).replace(/\./g, '/'),
        nameAndType: {
          name: name.value,
          descriptor: classToDescriptor(type),
        },
      };
      return new MethodHandle('putField', reference, type);
    },
  },
};