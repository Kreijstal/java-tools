module.exports = {
  super: 'javax/swing/JComponent',
  methods: {
    '<init>()V': (jvm, obj) => {
      const base = require('./JComponent.js');
      base.methods['<init>()V'](jvm, obj);
      obj._background = { r: 255, g: 255, b: 255 };
    },
  },
};
