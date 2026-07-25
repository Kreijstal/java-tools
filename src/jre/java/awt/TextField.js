module.exports = {
  super: 'java/awt/Component',
  fields: {
    'text:Ljava/lang/String;': null,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => initTextField(obj, ''),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initTextField(obj, args[0] || ''),
    'getText()Ljava/lang/String;': (jvm, obj, args) => obj.text || '',
    'setText(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.text = args[0] || '';
      setField(obj);
    },
    'addActionListener(Ljava/awt/event/ActionListener;)V': (jvm, obj, args) => addListener(obj, args[0]),
    'removeActionListener(Ljava/awt/event/ActionListener;)V': (jvm, obj, args) => removeListener(obj, args[0]),
  },
};

function initTextField(obj, text) {
  obj.text = text;
  obj._actionListeners = [];
  setField(obj);
}

function setField(obj) {
  obj.fields = obj.fields || {};
  obj.fields['java/awt/TextField.text'] = obj.text;
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
