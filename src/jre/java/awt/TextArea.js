// java.awt.TextArea - Multi-line text editing component

module.exports = {
  super: 'java/awt/Component',
  fields: {
    'text:Ljava/lang/String;': null,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => initTextArea(obj, '', 0, 0),
    '<init>(II)V': (jvm, obj, args) => initTextArea(obj, '', args[0] || 0, args[1] || 0),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initTextArea(obj, args[0] || '', 0, 0),
    '<init>(Ljava/lang/String;II)V': (jvm, obj, args) => initTextArea(obj, args[0] || '', args[1] || 0, args[2] || 0),
    '<init>(Ljava/lang/String;III)V': (jvm, obj, args) => initTextArea(obj, args[0] || '', args[1] || 0, args[2] || 0),
    'getText()Ljava/lang/String;': (jvm, obj, args) => obj.text || '',
    'setText(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.text = args[0] || '';
      setField(obj);
    },
    'appendText(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.text = (obj.text || '') + (args[0] || '');
      setField(obj);
    },
    'append(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.text = (obj.text || '') + (args[0] || '');
      setField(obj);
    },
    'setEditable(Z)V': (jvm, obj, args) => {
      obj._editable = !!args[0];
    },
    'isEditable()Z': (jvm, obj, args) => (obj._editable === undefined ? 1 : obj._editable ? 1 : 0),
    'getColumns()I': (jvm, obj, args) => obj._columns || 0,
    'getRows()I': (jvm, obj, args) => obj._rows || 0,
  },
};

function initTextArea(obj, text, rows, cols) {
  obj.text = text;
  obj._rows = rows;
  obj._columns = cols;
  obj._editable = true;
  setField(obj);
}

function setField(obj) {
  obj.fields = obj.fields || {};
  obj.fields['java/awt/TextArea.text'] = obj.text;
}
