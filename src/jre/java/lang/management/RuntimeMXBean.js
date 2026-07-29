module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getSpecVersion()Ljava/lang/String;': (jvm) => jvm.internString('1.8'),
  },
};
