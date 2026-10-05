// javax.swing.JButton - a push button rendered as a <button>.
const { initButton } = require('./AbstractButton.js');

module.exports = {
  super: 'javax/swing/AbstractButton',
  methods: {
    '<init>()V': (jvm, obj) => initButton(jvm, obj, ''),
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => initButton(jvm, obj, args[0]),
    'isDefaultButton()Z': () => 0,
  },
};
