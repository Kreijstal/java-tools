module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {
    'lookup()Ljava/lang/invoke/MethodHandles$Lookup;': (jvm, obj, args) => {
      // Create a Lookup object
      const lookup = {
        type: 'java/lang/invoke/MethodHandles$Lookup'
      };
      return lookup;
    }
  },
  methods: {}
};