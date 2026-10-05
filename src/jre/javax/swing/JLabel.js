// javax.swing.JLabel - a text label rendered as a <span>.
const { initComponent } = require('./JComponent.js');

const ALIGN_CSS = { 0: 'center', 2: 'left', 4: 'right', 10: 'left', 11: 'right' };

function initLabel(jvm, obj, text, alignment) {
  initComponent(jvm, obj, 'span');
  obj._text = text || '';
  obj._horizontalAlignment = alignment;
  if (obj._awtElement) obj._awtElement.style.display = 'inline-block';
  render(obj);
}

function render(obj) {
  const element = obj._awtElement;
  if (!element) return;
  element.textContent = String(obj._text || '');
  element.style.textAlign = ALIGN_CSS[obj._horizontalAlignment] || 'left';
}

module.exports = {
  super: 'javax/swing/JComponent',
  interfaces: ['javax/swing/SwingConstants'],
  methods: {
    '<init>()V': (jvm, obj) => initLabel(jvm, obj, '', 10),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initLabel(jvm, obj, args[0], 10),
    '<init>(Ljava/lang/String;I)V': (jvm, obj, args) => initLabel(jvm, obj, args[0], args[1] | 0),
    'getText()Ljava/lang/String;': (jvm, obj) => obj._text || '',
    'setText(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj._text = args[0] || '';
      render(obj);
    },
    'getHorizontalAlignment()I': (jvm, obj) => obj._horizontalAlignment | 0,
    'setHorizontalAlignment(I)V': (jvm, obj, args) => {
      obj._horizontalAlignment = args[0] | 0;
      render(obj);
    },
    'setLabelFor(Ljava/awt/Component;)V': (jvm, obj, args) => { obj._labelFor = args[0] || null; },
    'getLabelFor()Ljava/awt/Component;': (jvm, obj) => obj._labelFor || null,
  },
};
