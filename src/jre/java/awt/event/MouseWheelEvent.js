module.exports = {
  super: 'java/awt/event/MouseEvent',
  methods: {
    'getWheelRotation()I': (jvm, obj) => obj.wheelRotation || 0,
  },
};
