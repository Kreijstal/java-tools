module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getSize()I': (jvm, obj) => obj._size || 0,
  },
};
