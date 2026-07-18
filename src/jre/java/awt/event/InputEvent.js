module.exports = {
  super: 'java/awt/event/ComponentEvent',
  methods: {
    'getWhen()J': (jvm, obj) => BigInt(obj.when || 0),
    'getModifiers()I': (jvm, obj) => obj.modifiers || 0,
    'isShiftDown()Z': (jvm, obj) => Boolean(obj.shiftDown),
    'isControlDown()Z': (jvm, obj) => Boolean(obj.controlDown),
    'isAltDown()Z': (jvm, obj) => Boolean(obj.altDown),
    'consume()V': (jvm, obj) => { obj._consumed = true; },
  },
};
