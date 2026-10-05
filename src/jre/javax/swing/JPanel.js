// javax.swing.JPanel - generic lightweight container; FlowLayout by default.
const { initComponent } = require('./JComponent.js');
const containerBase = require('../../java/awt/Container.js');

function defaultLayout() {
  return { type: 'java/awt/FlowLayout', _align: 1, _hgap: 5, _vgap: 5 };
}

function initPanel(jvm, obj, layout) {
  initComponent(jvm, obj);
  obj._opaque = true;
  containerBase.methods['setLayout(Ljava/awt/LayoutManager;)V'](
    jvm, obj, [layout || defaultLayout()]);
}

module.exports = {
  super: 'javax/swing/JComponent',
  initPanel,
  methods: {
    '<init>()V': (jvm, obj) => initPanel(jvm, obj, null),
    '<init>(Z)V': (jvm, obj) => initPanel(jvm, obj, null),
    '<init>(Ljava/awt/LayoutManager;)V': (jvm, obj, args) => initPanel(jvm, obj, args[0]),
    '<init>(Ljava/awt/LayoutManager;Z)V': (jvm, obj, args) => initPanel(jvm, obj, args[0]),
  },
};
