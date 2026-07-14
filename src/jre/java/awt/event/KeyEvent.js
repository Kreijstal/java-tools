module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getKeyCode()I': (jvm, obj) => obj.keyCode || 0,
    'getKeyChar()C': (jvm, obj) => obj.keyChar || 0,
    'getModifiers()I': (jvm, obj) => obj.modifiers || 0,
    'consume()V': (jvm, obj) => { obj.consumed = true; },
  },
};
