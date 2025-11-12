const { withThrows } = require('../../helpers');

module.exports = {
  super: 'java/lang/Object',
  isInterface: true,
  staticFields: {},
  methods: {
    'run()V': withThrows((jvm, obj, args) => {
      // This is an interface method, so it should not be called directly.
      // The implementation is provided by the class that implements this interface.
      throw {
        type: 'java/lang/AbstractMethodError',
        message: 'java/lang/Runnable.run() is abstract',
      };
    }, ['java/lang/AbstractMethodError']),
  },
};
