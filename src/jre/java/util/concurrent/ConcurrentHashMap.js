module.exports = {
  super: 'java/util/HashMap',
  interfaces: ['java/util/concurrent/ConcurrentMap'],
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.map = new Map();
      obj.sizeCache = 0;
    },
  },
};
