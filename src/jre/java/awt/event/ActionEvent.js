module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/lang/Object;ILjava/lang/String;)V': (jvm, obj, args) => {
      obj._source = args[0];
      obj._id = args[1];
      obj._command = args[2] ? String(args[2]) : '';
    },

    'getActionCommand()Ljava/lang/String;': (jvm, obj) => {
      return jvm.internString(obj._command || '');
    },
  },
};
