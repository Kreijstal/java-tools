const environment = { type: 'java/awt/GraphicsEnvironment' };

module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getDefaultScreenDevice()Ljava/awt/GraphicsDevice;': (jvm, obj) => obj._defaultScreenDevice || null,
    'getScreenDevices()[Ljava/awt/GraphicsDevice;': (jvm, obj) => obj._screenDevices || [],
  },
  staticMethods: {
    'getLocalGraphicsEnvironment()Ljava/awt/GraphicsEnvironment;': () => environment,
  },
};
