module.exports = {
  super: 'java/util/AbstractList',
  interfaces: ['java/util/List'],
  methods: {
    '<init>()V': (jvm, obj) => {
      // no-op constructor for abstract base class shim
    },
  },
};
