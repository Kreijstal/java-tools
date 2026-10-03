'use strict';

// Installation has already resolved and validated this native binding.
// Read the declared slot on every invocation to observe class/method
// replacement, but repeat hierarchical JNI resolution only when its registry
// changes. Capture the signature once instead of rebuilding it in hot loops.
module.exports = function directJreInitializationGuard(jvm, entry, native, intrinsic) {
  const {className, methodName, descriptor} = entry;
  const signature = methodName + descriptor;
  const token = jvm.getClassInitializationToken(className);
  let registryVersion = jvm.jni.registryVersion;
  let nativeMatches = true;
  return {
    get initialized() {
      if (!token.initialized) return false;
      const owner = jvm.jre[className];
      if ((owner?.methods?.[signature] || owner?.staticMethods?.[signature]) !== native) return false;
      if (registryVersion !== jvm.jni.registryVersion) {
        nativeMatches = jvm._jreFindMethod(className, methodName, descriptor) === native;
        registryVersion = jvm.jni.registryVersion;
      }
      return nativeMatches && native.jvmDirectFinal === true &&
        native.jvmDirectIntrinsic === intrinsic;
    },
  };
};
