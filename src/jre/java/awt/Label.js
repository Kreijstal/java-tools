module.exports = {
  super: 'java/awt/Component',
  staticFields: {
    'LEFT:I': 0,
    'CENTER:I': 1,
    'RIGHT:I': 2,
  },
  fields: {
    'text:Ljava/lang/String;': null,
    'alignment:I': 0,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => initLabel(obj, '', 0),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initLabel(obj, args[0] || '', 0),
    '<init>(Ljava/lang/String;I)V': (jvm, obj, args) => initLabel(obj, args[0] || '', args[1] || 0),
    'getText()Ljava/lang/String;': (jvm, obj, args) => obj.text || '',
    'setText(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.text = args[0] || '';
      setFields(obj);
    },
  },
};

function initLabel(obj, text, alignment) {
  obj.text = text;
  obj.alignment = alignment;
  obj._visible = true;
  setFields(obj);
}

function setFields(obj) {
  obj.fields = obj.fields || {};
  obj.fields['java/awt/Label.text'] = obj.text;
  obj.fields['java/awt/Label.alignment'] = obj.alignment;
}
