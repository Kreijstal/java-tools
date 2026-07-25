const defaultDevice = { type: 'java/awt/GraphicsDevice' };
const localEnv = { type: 'java/awt/GraphicsEnvironment', _defaultDevice: defaultDevice };

module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getDefaultScreenDevice()Ljava/awt/GraphicsDevice;': () => defaultDevice,
    'getScreenDevices()[Ljava/awt/GraphicsDevice;': () => [defaultDevice],
  },
  staticMethods: {
    'getLocalGraphicsEnvironment()Ljava/awt/GraphicsEnvironment;': () => localEnv,
    'isHeadless()Z': () => 0,
  },
};
