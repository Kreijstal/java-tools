module.exports = {
  super: 'java/awt/event/MouseEvent',
  // Values from the JDK's public static final fields.
  staticFields: {
    'WHEEL_UNIT_SCROLL:I': 0,
    'WHEEL_BLOCK_SCROLL:I': 1,
  },
  methods: {
    'getWheelRotation()I': (jvm, obj) => obj.wheelRotation || 0,
  },
};
