const Frame = require('../../../../frame');

module.exports = {
  'java/lang/reflect/Method.getName()Ljava/lang/String;': (jvm, methodObj, args) => {
    const methodName = methodObj._methodData.name;
    return jvm.internString(methodName);
  },
};
