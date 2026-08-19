// Named by java.io serialization code that voidhunters catches; without a model
// the frontend could not resolve the simple name under `import java.io.*` and
// emitted a default-package class reference that exists nowhere.
module.exports = {
  super: 'java/io/ObjectStreamException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.message = null;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
    },
  },
};
