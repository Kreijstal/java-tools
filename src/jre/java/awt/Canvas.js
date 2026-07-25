module.exports = {
  super: 'java/awt/Component',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._visible = true;
      obj._listeners = {};
    },
  },
};
