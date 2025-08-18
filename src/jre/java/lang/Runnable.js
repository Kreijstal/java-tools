module.exports = {
  super: 'java/lang/Object',
  isInterface: true,
  staticFields: {},
  methods: {
    'run()V': (jvm, obj, args) => {
      // This is an interface method, so it should not be called directly.
      // The implementation is provided by the class that implements this interface.
      throw new Error('AbstractMethodError: a new error');
    },
  },
};
