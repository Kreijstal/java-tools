module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/lang/Object;)V': (jvm, obj, args) => { obj.source = args[0]; },
    'getSource()Ljava/lang/Object;': (jvm, obj) => obj.source || null,
  },
};
