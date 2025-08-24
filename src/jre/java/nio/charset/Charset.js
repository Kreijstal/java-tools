const JNI = require('../../../../jni');

module.exports = {
  super: "java/lang/Object",
  staticMethods: {
    'forName(Ljava/lang/String;)Ljava/nio/charset/Charset;': (jvm, obj, args) => {
      const charsetName = JNI.fromJavaString(args[0]);
      const charset = new JNI.java.lang.Object();
      charset['java/nio/charset/Charset/name'] = charsetName;
      return charset;
    },
  },
};
