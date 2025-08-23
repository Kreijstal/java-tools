const JNI = require('../../../../jni');

module.exports = {
  'java/nio/charset/Charset': {
    'forName(Ljava/lang/String;)Ljava/nio/charset/Charset;': (thread, locals) => {
      const charsetName = JNI.fromJavaString(locals[0]);
      const charset = new JNI.java.lang.Object();
      charset['java/nio/charset/Charset/name'] = charsetName;
      thread.pushStack(charset);
    },
  },
};
