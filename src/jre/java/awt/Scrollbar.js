const dispatchAdjustmentEvent = async (jvm, source, listener) => {
  if (!listener || !listener.type) return;
  const method = jvm.findMethod(jvm.classes[listener.type], 'adjustmentValueChanged', '(Ljava/awt/event/AdjustmentEvent;)V');
  if (!method) return;

  const eventObj = { type: 'java/awt/event/AdjustmentEvent', source: source, value: source._value };
  const Frame = require('../../../frame');
  const eventFrame = new Frame(method);
  eventFrame.className = listener.type;
  eventFrame.locals[0] = listener;
  eventFrame.locals[1] = eventObj;

  const currentThread = jvm.threads[jvm.currentThreadIndex] || jvm.threads[0];
  if (!currentThread) return;
  currentThread.callStack.push(eventFrame);
  currentThread.status = 'runnable';

  const originalStackSize = currentThread.callStack.size();
  let iterations = 0;
  const maxIterations = 1000;
  while (currentThread.callStack.size() >= originalStackSize && iterations < maxIterations) {
    const result = await jvm.executeTick();
    iterations++;
    if (result && result.completed) break;
  }
};

const updateDomRange = (obj) => {
  if (!obj._awtElement) return;
  const maxValue = Math.max(obj._minimum, obj._maximum - obj._visibleAmount);
  obj._awtElement.min = obj._minimum;
  obj._awtElement.max = maxValue;
  obj._awtElement.value = obj._value;
};

module.exports = {
  super: 'java/awt/Component',
  staticFields: {
    'HORIZONTAL:I': 0,
    'VERTICAL:I': 1
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._orientation = 0;
      obj._value = 0;
      obj._visibleAmount = 1;
      obj._minimum = 0;
      obj._maximum = 100;
      obj._adjustmentListeners = [];
      if (typeof document !== 'undefined') {
        const input = document.createElement('input');
        input.type = 'range';
        input.style.width = '100%';
        obj._awtElement = input;
        updateDomRange(obj);
        input.addEventListener('input', () => {
          obj._value = parseInt(input.value, 10) || 0;
          for (const listener of obj._adjustmentListeners) {
            dispatchAdjustmentEvent(jvm, obj, listener);
          }
        });
      }
    },

    '<init>(I)V': (jvm, obj, args) => {
      const baseInit = jvm._jreFindMethod(obj.type, '<init>', '()V');
      if (baseInit) {
        baseInit(jvm, obj, []);
      }
      obj._orientation = args[0];
    },

    '<init>(IIIII)V': (jvm, obj, args) => {
      const baseInit = jvm._jreFindMethod(obj.type, '<init>', '()V');
      if (baseInit) {
        baseInit(jvm, obj, []);
      }
      obj._orientation = args[0];
      obj._value = args[1];
      obj._visibleAmount = args[2];
      obj._minimum = args[3];
      obj._maximum = args[4];
      updateDomRange(obj);
      if (obj._orientation === 1 && obj._awtElement) {
        obj._awtElement.style.writingMode = 'bt-lr';
        obj._awtElement.style.height = '120px';
      }
    },

    'getValue()I': (jvm, obj, args) => obj._value,

    'setValue(I)V': (jvm, obj, args) => {
      obj._value = args[0];
      updateDomRange(obj);
    },

    'addAdjustmentListener(Ljava/awt/event/AdjustmentListener;)V': (jvm, obj, args) => {
      const listener = args[0];
      if (!listener) return;
      obj._adjustmentListeners = obj._adjustmentListeners || [];
      obj._adjustmentListeners.push(listener);
    }
  },
};
