module.exports = {
  super: "java/lang/Exception",
  methods: {
    '<init>()V': (jvm, obj, args) => {},
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
        const message = args[0];
        obj.message = message;
    },
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => {
        return obj.message || null;
    }
  },
};
