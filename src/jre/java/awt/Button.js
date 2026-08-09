// java.awt.Button - A labeled push button.
// Renders a real <button> element and dispatches ActionEvents to registered
// action listeners through the JVM's AWT event queue.

function initButton(jvm, obj, label) {
  obj.label = label || '';
  obj._actionListeners = [];
  obj._enabled = true;
  obj._ownerJvm = jvm;
  setField(obj);
  if (typeof document !== 'undefined') {
    if (!obj._awtElement) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = obj.label;
      el.style.cssText = 'padding: 3px 10px; font: inherit; cursor: pointer; background: #f0f0f0; border: 1px solid #999; border-radius: 3px;';
      el.addEventListener('click', () => {
        if (obj._enabled === false) return;
        dispatchClick(jvm, obj);
      });
      obj._awtElement = el;
    } else {
      obj._awtElement.textContent = obj.label;
    }
  }
}

function setField(obj) {
  obj.fields = obj.fields || {};
  obj.fields['java/awt/Button.label'] = obj.label;
}

function dispatchClick(jvm, obj) {
  // Legacy pre-1.1 model: post a java.awt.Event up the hierarchy
  // (handleEvent/action overrides). Falls back to ActionListener if the
  // event is not consumed anywhere.
  const { postActionEvent } = require('./legacyEvents');
  postActionEvent(jvm, obj, obj.label || '').catch((error) => {
    console.error('AWT Button legacy action dispatch failed:', error);
    return false;
  }).then((handled) => {
    if (handled) return;
    // Modern path: dispatch to registered ActionListeners.
    const eventObj = {
      type: 'java/awt/event/ActionEvent',
      source: obj,
      command: obj.label || '',
      when: Date.now(),
      modifiers: 0,
    };
    const listeners = obj._actionListeners || [];
    if (listeners.length === 0) {
      console.log('AWT Button click (unhandled):', obj.label);
      return;
    }
    for (const listener of listeners) {
      if (!listener || !listener.type) continue;
      jvm.enqueueAwtEventInvocation(
        listener,
        'actionPerformed',
        '(Ljava/awt/event/ActionEvent;)V',
        eventObj,
      );
    }
  });
}

function addListener(obj, listener) {
  if (!listener) return;
  obj._actionListeners = obj._actionListeners || [];
  if (!obj._actionListeners.includes(listener)) obj._actionListeners.push(listener);
}

function removeListener(obj, listener) {
  if (!obj._actionListeners) return;
  const index = obj._actionListeners.indexOf(listener);
  if (index !== -1) obj._actionListeners.splice(index, 1);
}

module.exports = {
  super: 'java/awt/Component',
  fields: {
    'label:Ljava/lang/String;': null,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => initButton(jvm, obj, ''),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initButton(jvm, obj, args[0] || ''),
    'addActionListener(Ljava/awt/event/ActionListener;)V': (jvm, obj, args) => addListener(obj, args[0]),
    'removeActionListener(Ljava/awt/event/ActionListener;)V': (jvm, obj, args) => removeListener(obj, args[0]),
    'getLabel()Ljava/lang/String;': (jvm, obj, args) => obj.label || '',
    'setLabel(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.label = args[0] || '';
      setField(obj);
      if (obj._awtElement) obj._awtElement.textContent = obj.label;
    },
    'setEnabled(Z)V': (jvm, obj, args) => {
      obj._enabled = !!args[0];
      if (obj._awtElement) obj._awtElement.disabled = !obj._enabled;
    },
    'isEnabled()Z': (jvm, obj, args) => (obj._enabled === undefined ? 1 : obj._enabled ? 1 : 0),
  },
};
