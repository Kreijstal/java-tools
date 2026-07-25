module.exports = {
  super: 'java/awt/Component',
  fields: {
    'label:Ljava/lang/String;': null,
    'state:Z': 0,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => initCheckbox(obj, '', 0),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initCheckbox(obj, args[0] || '', 0),
    '<init>(Ljava/lang/String;Z)V': (jvm, obj, args) => initCheckbox(obj, args[0] || '', args[1] ? 1 : 0),
    'getState()Z': (jvm, obj, args) => obj.state ? 1 : 0,
    'setState(Z)V': (jvm, obj, args) => {
      obj.state = args[0] ? 1 : 0;
      setFields(obj);
    },
    'addItemListener(Ljava/awt/event/ItemListener;)V': (jvm, obj, args) => addListener(obj, args[0]),
    'removeItemListener(Ljava/awt/event/ItemListener;)V': (jvm, obj, args) => removeListener(obj, args[0]),
  },
};

function initCheckbox(obj, label, state) {
  obj.label = label;
  obj.state = state;
  obj._itemListeners = [];
  setFields(obj);
}

function setFields(obj) {
  obj.fields = obj.fields || {};
  obj.fields['java/awt/Checkbox.label'] = obj.label;
  obj.fields['java/awt/Checkbox.state'] = obj.state;
}

function addListener(obj, listener) {
  if (!listener) return;
  obj._itemListeners = obj._itemListeners || [];
  if (!obj._itemListeners.includes(listener)) obj._itemListeners.push(listener);
}

function removeListener(obj, listener) {
  if (!obj._itemListeners) return;
  const index = obj._itemListeners.indexOf(listener);
  if (index !== -1) obj._itemListeners.splice(index, 1);
}
