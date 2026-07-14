module.exports = {
  super: 'java/lang/Object',
  methods: {
    'get()Ljava/lang/Object;': (jvm, obj) => obj._referent || null,
    'clear()V': (jvm, obj) => { obj._referent = null; },
  },
};
