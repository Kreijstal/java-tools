module.exports = {
  'java/lang/Object.getClass()Ljava/lang/Class;': (jvm, obj, args) => {
    const className = obj.type;
    const classData = jvm.classes[className];
    return {
      type: 'java/lang/Class',
      _classData: classData,
    };
  },

  'java/lang/Object.hashCode()I': (jvm, obj, args) => {
    return obj.hashCode;
  },

  'java/lang/Object.equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
    const other = args[0];
    return obj === other ? 1 : 0;
  },

  'java/lang/Object.toString()Ljava/lang/String;': (jvm, obj, args) => {
    const className = obj.type.replace(/\//g, '.');
    const hashCode = obj.hashCode.toString(16);
    return jvm.internString(`${className}@${hashCode}`);
  },
};
