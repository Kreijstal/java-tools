module.exports = {
  super: 'java/awt/Component',
  fields: {
    'label:Ljava/lang/String;': null,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => initButton(obj, ''),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initButton(obj, args[0] || ''),
    'addActionListener(Ljava/awt/event/ActionListener;)V': (jvm, obj, args) => addListener(obj, args[0]),
    'removeActionListener(Ljava/awt/event/ActionListener;)V': (jvm, obj, args) => removeListener(obj, args[0]),
    'getLabel()Ljava/lang/String;': (jvm, obj, args) => obj.label || '',
    'setLabel(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.label = args[0] || '';
      setField(obj);
    },
  },
};

function initButton(obj, label) {
  obj.label = label;
  obj._actionListeners = [];
  obj._enabled = true;
  setField(obj);
}

function setField(obj) {
  obj.fields = obj.fields || {};
  obj.fields['java/awt/Button.label'] = obj.label;
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
