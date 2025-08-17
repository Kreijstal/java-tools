module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'out:Ljava/io/PrintStream;': {
      type: 'java/io/PrintStream',
      // This is a simplified representation of the PrintStream object.
      // In a real implementation, this would be a more complex object
      // that is properly initialized.
      _isJreObject: true,
    },
  },
  methods: {
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      throw new Error('NotImplementedError: System.getProperty is not implemented.');
    },
  },
};
