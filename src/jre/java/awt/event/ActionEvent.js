module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => obj.source || null,
  },
};
