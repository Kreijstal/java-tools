module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getDisplayMode()Ljava/awt/DisplayMode;': (jvm, obj) => obj._displayMode || null,
    'getDisplayModes()[Ljava/awt/DisplayMode;': (jvm, obj) => obj._displayModes || [],
    'isFullScreenSupported()Z': () => 0,
    'setDisplayMode(Ljava/awt/DisplayMode;)V': (jvm, obj, args) => { obj._displayMode = args[0] || null; },
    'setFullScreenWindow(Ljava/awt/Window;)V': (jvm, obj, args) => { obj._fullScreenWindow = args[0] || null; },
  },
};
