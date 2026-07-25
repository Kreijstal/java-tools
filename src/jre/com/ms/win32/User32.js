const { getLegacyPlatform } = require('../../../../platform/legacy');

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
  },
  staticMethods: {
    'GetWindowLong(II)I': (jvm, obj, args) => {
      const [hwnd, index] = args;
      return getWindowLongStore(jvm).get(`${hwnd}:${index}`) || 0;
    },
    'SetWindowLong(III)I': (jvm, obj, args) => setWindowLong(jvm, args[0], args[1], args[2]),
    'SetWindowLong(IILjava/lang/Object;)I': (jvm, obj, args) => {
      const handle = allocateObjectHandle(jvm, args[2]);
      return setWindowLong(jvm, args[0], args[1], handle);
    },
    'CallWindowProc(IIIII)I': () => 0,
    'LoadCursor(II)I': (jvm, obj, args) => args[1] || 0,
    'SetCursor(I)I': (jvm, obj, args) => {
      const cursor = args[0] || 0;
      return getLegacyPlatform().setCursor(cursor);
    },
    'SendMessage(IIII)I': () => 0,
    'SetCursorPos(II)Z': (jvm, obj, args) => {
      jvm._lastCursorPos = getLegacyPlatform().setCursorPos(args[0] || 0, args[1] || 0);
      return 0;
    },
  },
};

function getWindowLongStore(jvm) {
  if (!jvm._user32WindowLongs) {
    jvm._user32WindowLongs = new Map();
  }
  return jvm._user32WindowLongs;
}

function setWindowLong(jvm, hwnd, index, value) {
  const store = getWindowLongStore(jvm);
  const key = `${hwnd}:${index}`;
  const previous = store.get(key) || 0;
  store.set(key, value || 0);
  return previous;
}

function allocateObjectHandle(jvm, value) {
  if (!value) return 0;
  if (!jvm._user32ObjectHandles) {
    jvm._user32ObjectHandles = new Map();
    jvm._nextUser32ObjectHandle = 1;
  }
  const handle = jvm._nextUser32ObjectHandle++;
  jvm._user32ObjectHandles.set(handle, value);
  return handle;
}
