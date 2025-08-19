module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    'setAccessible(Z)V': (jvm, accessibleObj, args) => {
      const accessible = args[0];
      accessibleObj._accessible = accessible;
    },
    'isAccessible()Z': (jvm, accessibleObj, args) => {
      return accessibleObj._accessible || false;
    },
  }
};