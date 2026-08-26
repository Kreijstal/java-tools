const BUTTONS = [
  { masks: [16, 1024], button: 0, buttons: 1 },
  { masks: [8, 2048], button: 1, buttons: 4 },
  { masks: [4, 4096], button: 2, buttons: 2 },
];

function browserAvailable() {
  return typeof document !== 'undefined' && typeof MouseEvent !== 'undefined';
}

function unsupported() {
  throw {
    type: 'java/lang/UnsupportedOperationException',
    message: 'java.awt.Robot native input is not configured for Node.js',
  };
}

function state(obj) {
  if (!obj._robotState) {
    obj._robotState = { x: 0, y: 0, buttons: 0, autoDelay: 0,
      autoWaitForIdle: false, pressedKeys: new Set() };
  }
  return obj._robotState;
}

function visibleCanvas(jvm, x, y) {
  const hit = document.elementFromPoint?.(x, y);
  if (hit?.tagName === 'CANVAS') return hit;
  if (hit?.closest) {
    const canvas = hit.closest('canvas');
    if (canvas) return canvas;
  }
  return jvm?._awtFocusedComponent?._canvasElement || jvm?._awtCanvasElement ||
    [...document.querySelectorAll('canvas')].reverse().find(canvas => {
      const rect = canvas.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) || null;
}

function mouseInit(robot, button = 0) {
  return {
    bubbles: true, cancelable: true, composed: true,
    clientX: robot.x, clientY: robot.y, screenX: robot.x, screenY: robot.y,
    button, buttons: robot.buttons, detail: 1,
    view: typeof window !== 'undefined' ? window : null,
  };
}

function dispatchMouse(jvm, obj, type, button = 0) {
  if (!browserAvailable()) unsupported();
  const robot = state(obj);
  const target = visibleCanvas(jvm, robot.x, robot.y);
  if (target) target.dispatchEvent(new MouseEvent(type, mouseInit(robot, button)));
}

function dispatchWheel(jvm, obj, amount) {
  if (!browserAvailable() || typeof WheelEvent === 'undefined') unsupported();
  const robot = state(obj);
  const target = visibleCanvas(jvm, robot.x, robot.y);
  if (target) target.dispatchEvent(new WheelEvent('wheel', {
    ...mouseInit(robot), deltaY: amount, deltaMode: 1,
  }));
}

function selectedButtons(mask) {
  return BUTTONS.filter(entry => entry.masks.some(value => (mask & value) !== 0));
}

function keyDescription(code) {
  if (code >= 65 && code <= 90) {
    const letter = String.fromCharCode(code);
    return { key: letter.toLowerCase(), code: `Key${letter}` };
  }
  if (code >= 48 && code <= 57) {
    const digit = String.fromCharCode(code);
    return { key: digit, code: `Digit${digit}` };
  }
  if (code >= 112 && code <= 123) {
    const key = `F${code - 111}`;
    return { key, code: key };
  }
  return {
    8: { key: 'Backspace', code: 'Backspace' },
    9: { key: 'Tab', code: 'Tab' },
    10: { key: 'Enter', code: 'Enter' },
    16: { key: 'Shift', code: 'ShiftLeft' },
    17: { key: 'Control', code: 'ControlLeft' },
    18: { key: 'Alt', code: 'AltLeft' },
    27: { key: 'Escape', code: 'Escape' },
    32: { key: ' ', code: 'Space' },
    33: { key: 'PageUp', code: 'PageUp' },
    34: { key: 'PageDown', code: 'PageDown' },
    35: { key: 'End', code: 'End' },
    36: { key: 'Home', code: 'Home' },
    37: { key: 'ArrowLeft', code: 'ArrowLeft' },
    38: { key: 'ArrowUp', code: 'ArrowUp' },
    39: { key: 'ArrowRight', code: 'ArrowRight' },
    40: { key: 'ArrowDown', code: 'ArrowDown' },
    45: { key: 'Insert', code: 'Insert' },
    46: { key: 'Delete', code: 'Delete' },
  }[code] || { key: 'Unidentified', code: '' };
}

function dispatchKey(jvm, obj, type, keyCode) {
  if (!browserAvailable() || typeof KeyboardEvent === 'undefined') unsupported();
  const robot = state(obj);
  const description = keyDescription(keyCode);
  const target = document.activeElement?._jvmAwtInputAttached
    ? document.activeElement : visibleCanvas(jvm, robot.x, robot.y);
  if (!target) return;
  if (type === 'keydown') robot.pressedKeys.add(keyCode);
  else robot.pressedKeys.delete(keyCode);
  target.dispatchEvent(new KeyboardEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    key: description.key, code: description.code, keyCode, which: keyCode,
    shiftKey: robot.pressedKeys.has(16), ctrlKey: robot.pressedKeys.has(17),
    altKey: robot.pressedKeys.has(18),
    metaKey: robot.pressedKeys.has(157) || robot.pressedKeys.has(524),
  }));
}

async function afterEvent(obj) {
  const robot = state(obj);
  if (robot.autoDelay > 0) {
    await new Promise(resolve => setTimeout(resolve, robot.autoDelay));
  }
  if (robot.autoWaitForIdle) await new Promise(resolve => setTimeout(resolve, 0));
}

function checkedDelay(value) {
  const delay = value | 0;
  if (delay < 0 || delay > 60000) throw {
    type: 'java/lang/IllegalArgumentException',
    message: 'Delay must be 0 to 60,000ms',
  };
  return delay;
}

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': (jvm, obj) => {
      if (!browserAvailable()) unsupported();
      state(obj);
    },
    '<init>(Ljava/awt/GraphicsDevice;)V': (jvm, obj) => {
      if (!browserAvailable()) unsupported();
      state(obj);
    },
    'mouseMove(II)V': async (jvm, obj, args) => {
      const robot = state(obj);
      robot.x = args[0] | 0;
      robot.y = args[1] | 0;
      dispatchMouse(jvm, obj, 'mousemove');
      await afterEvent(obj);
    },
    'mousePress(I)V': async (jvm, obj, args) => {
      for (const entry of selectedButtons(args[0] | 0)) {
        state(obj).buttons |= entry.buttons;
        dispatchMouse(jvm, obj, 'mousedown', entry.button);
      }
      await afterEvent(obj);
    },
    'mouseRelease(I)V': async (jvm, obj, args) => {
      for (const entry of selectedButtons(args[0] | 0)) {
        state(obj).buttons &= ~entry.buttons;
        dispatchMouse(jvm, obj, 'mouseup', entry.button);
        dispatchMouse(jvm, obj, 'click', entry.button);
      }
      await afterEvent(obj);
    },
    'mouseWheel(I)V': async (jvm, obj, args) => {
      dispatchWheel(jvm, obj, args[0] | 0);
      await afterEvent(obj);
    },
    'keyPress(I)V': async (jvm, obj, args) => {
      dispatchKey(jvm, obj, 'keydown', args[0] | 0);
      await afterEvent(obj);
    },
    'keyRelease(I)V': async (jvm, obj, args) => {
      dispatchKey(jvm, obj, 'keyup', args[0] | 0);
      await afterEvent(obj);
    },
    'setAutoDelay(I)V': (jvm, obj, args) => {
      state(obj).autoDelay = checkedDelay(args[0]);
    },
    'getAutoDelay()I': (jvm, obj) => state(obj).autoDelay,
    'setAutoWaitForIdle(Z)V': (jvm, obj, args) => {
      state(obj).autoWaitForIdle = Boolean(args[0]);
    },
    'isAutoWaitForIdle()Z': (jvm, obj) => state(obj).autoWaitForIdle,
    'delay(I)V': async (jvm, obj, args) => {
      await new Promise(resolve => setTimeout(resolve, checkedDelay(args[0])));
    },
    'waitForIdle()V': async () => {
      if (!browserAvailable()) unsupported();
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  },
};
