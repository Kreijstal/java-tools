module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    'valueOf(I)Ljava/lang/Integer;': (jvm, _, args) => {
      return args[0];
    },
  },
};
