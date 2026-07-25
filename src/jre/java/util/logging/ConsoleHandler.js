module.exports = {
  super: 'java/util/logging/Handler',
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.formatter = null;
      obj.level = null;
    },
  },
};
