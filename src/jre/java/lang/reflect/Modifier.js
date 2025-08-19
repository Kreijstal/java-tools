module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    // Modifier constants
    PUBLIC: 0x00000001,      // 1
    PRIVATE: 0x00000002,     // 2  
    PROTECTED: 0x00000004,   // 4
    STATIC: 0x00000008,      // 8
    FINAL: 0x00000010,       // 16
    SYNCHRONIZED: 0x00000020, // 32
    VOLATILE: 0x00000040,    // 64
    TRANSIENT: 0x00000080,   // 128
    NATIVE: 0x00000100,      // 256
    INTERFACE: 0x00000200,   // 512
    ABSTRACT: 0x00000400,    // 1024
    STRICT: 0x00000800,      // 2048
  },
  methods: {
    'isPublic(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000001) !== 0;
    },
    'isPrivate(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000002) !== 0;
    },
    'isProtected(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000004) !== 0;
    },
    'isStatic(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000008) !== 0;
    },
    'isFinal(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000010) !== 0;
    },
    'isSynchronized(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000020) !== 0;
    },
    'isVolatile(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000040) !== 0;
    },
    'isTransient(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000080) !== 0;
    },
    'isNative(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000100) !== 0;
    },
    'isInterface(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000200) !== 0;
    },
    'isAbstract(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000400) !== 0;
    },
    'isStrict(I)Z': (jvm, classObj, args) => {
      const mod = args[0];
      return (mod & 0x00000800) !== 0;
    },
    'toString(I)Ljava/lang/String;': (jvm, classObj, args) => {
      const mod = args[0];
      const modifiers = [];
      
      if (mod & 0x00000001) modifiers.push('public');
      if (mod & 0x00000002) modifiers.push('private');
      if (mod & 0x00000004) modifiers.push('protected');
      if (mod & 0x00000008) modifiers.push('static');
      if (mod & 0x00000010) modifiers.push('final');
      if (mod & 0x00000020) modifiers.push('synchronized');
      if (mod & 0x00000040) modifiers.push('volatile');
      if (mod & 0x00000080) modifiers.push('transient');
      if (mod & 0x00000100) modifiers.push('native');
      if (mod & 0x00000200) modifiers.push('interface');
      if (mod & 0x00000400) modifiers.push('abstract');
      if (mod & 0x00000800) modifiers.push('strictfp');
      
      return jvm.internString(modifiers.join(' '));
    },
  }
};