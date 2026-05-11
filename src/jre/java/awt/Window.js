module.exports = {
  super: 'java/awt/Container',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._visible = false;
    },
  },
};
