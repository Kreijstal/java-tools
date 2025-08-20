module.exports = {
    super: 'java/lang/RuntimeException',
    methods: {
        '<init>()V': (jvm, obj, args) => {
            const RuntimeException = jvm.findClass('java/lang/RuntimeException');
            RuntimeException.methods['<init>()V'](jvm, obj, []);
        },
        '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
            const RuntimeException = jvm.findClass('java/lang/RuntimeException');
            RuntimeException.methods['<init>(Ljava/lang/String;)V'](jvm, obj, args);
        }
    }
};
