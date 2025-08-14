module.exports = {
  'java/lang/StringBuilder.<init>()V': (jvm, obj, args) => {
    obj.value = '';
    delete obj.isUninitialized;
  },
  'java/lang/StringBuilder.append(Ljava/lang/String;)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
    const str = args[0];
    obj.value += str;
    return obj;
  },
  'java/lang/StringBuilder.toString()Ljava/lang/String;': (jvm, obj, args) => {
    return jvm.internString(obj.value);
  },
};
