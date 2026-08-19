module.exports = {
  super: 'java/lang/Object',
  methods: {
    // Headless environment: report no fullscreen support so games fall back
    // to windowed mode instead of driving DisplayMode changes.
    'isFullScreenSupported()Z': () => 0,
    'isDisplayChangeSupported()Z': () => 0,
    'setFullScreenWindow(Ljava/awt/Window;)V': () => {},
    'getFullScreenWindow()Ljava/awt/Window;': () => null,
    // Nothing to change in a headless device; isDisplayChangeSupported already
    // reports 0, so a caller that checks first never gets here.
    'setDisplayMode(Ljava/awt/DisplayMode;)V': () => {},
    'getDisplayModes()[Ljava/awt/DisplayMode;': () => [],
    'getDisplayMode()Ljava/awt/DisplayMode;': () => ({
      type: 'java/awt/DisplayMode', _width: 800, _height: 600, _bitDepth: 32, _refreshRate: 60,
    }),
  },
};
