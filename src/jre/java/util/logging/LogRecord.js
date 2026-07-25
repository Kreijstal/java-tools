module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/util/logging/Level;Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.level = args[0];
      obj.message = args[1];
    },
    'getMessage()Ljava/lang/String;': (jvm, obj) => obj.message || null,
    'getLevel()Ljava/util/logging/Level;': (jvm, obj) => obj.level || null,
  },
};
