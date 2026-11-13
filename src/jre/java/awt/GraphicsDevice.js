// One browser display per JVM; the environment's device object is shared by
// the native definitions, so keep mutable window/mode state out of that object.
const displays = new WeakMap();

function display(jvm) {
  if (!displays.has(jvm)) {
    const screen = typeof window !== 'undefined' ? window.screen : null;
    displays.set(jvm, {
      window: null,
      mode: {
        type: 'java/awt/DisplayMode',
        _width: screen?.width || 800, _height: screen?.height || 600,
        _bitDepth: screen?.colorDepth || 32, _refreshRate: 60,
      },
    });
  }
  return displays.get(jvm);
}

function browserFullscreenSupported() {
  return typeof document !== 'undefined' && document.fullscreenEnabled &&
    typeof document.documentElement?.requestFullscreen === 'function';
}

async function requestFullscreen(jvm, action) {
  try {
    await action();
  } catch (error) {
    jvm.throwException('java/lang/UnsupportedOperationException', String(error?.message || error));
  }
}

async function sizeWindow(jvm, state) {
  if (!state.window) return;
  const owner = state.window._className || state.window.type;
  const resize = jvm._jreFindMethod(owner, 'setSize', '(II)V');
  if (resize) await resize(jvm, state.window, [state.mode._width, state.mode._height]);
}

module.exports = {
  super: 'java/lang/Object',
  methods: {
    'isFullScreenSupported()Z': () => browserFullscreenSupported() ? 1 : 0,
    // Browsers can scale a virtual display, but cannot change the OS mode.
    'isDisplayChangeSupported()Z': () => 0,
    'setFullScreenWindow(Ljava/awt/Window;)V': async (jvm, obj, [frame]) => {
      if (!browserFullscreenSupported()) return;
      const state = display(jvm);
      if (!frame) {
        if (document.fullscreenElement) await requestFullscreen(jvm, () => document.exitFullscreen());
        state.window = null;
        return;
      }
      // Rejections propagate to the caller so a game can fall back to its
      // windowed mode. Do not claim success when browser policy blocks entry.
      if (!document.fullscreenElement) {
        await requestFullscreen(jvm, () => document.documentElement.requestFullscreen());
      }
      state.window = frame;
      await sizeWindow(jvm, state);
      const show = jvm._jreFindMethod(frame._className || frame.type, 'setVisible', '(Z)V');
      if (show) await show(jvm, frame, [1]);
    },
    'getFullScreenWindow()Ljava/awt/Window;': (jvm) =>
      typeof document !== 'undefined' && document.fullscreenElement ? display(jvm).window : null,
    'setDisplayMode(Ljava/awt/DisplayMode;)V': async (jvm, obj, [mode]) => {
      if (!browserFullscreenSupported()) return;
      const state = display(jvm);
      state.mode = mode;
      await sizeWindow(jvm, state);
    },
    'getDisplayModes()[Ljava/awt/DisplayMode;': (jvm) => {
      if (!browserFullscreenSupported()) return [];
      const current = display(jvm).mode;
      const modes = [current];
      for (const [width, height] of [[640, 480], [800, 600], [1024, 768]]) {
        if (!modes.some(mode => mode._width === width && mode._height === height)) {
          modes.push({type: 'java/awt/DisplayMode', _width: width, _height: height,
            _bitDepth: current._bitDepth, _refreshRate: current._refreshRate});
        }
      }
      return modes;
    },
    'getDisplayMode()Ljava/awt/DisplayMode;': (jvm) => display(jvm).mode,
  },
};
