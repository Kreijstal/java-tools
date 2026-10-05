// javax.swing.AbstractButton - text, action command and ActionListeners.
// Listeners run on the event dispatch thread, so lambdas and anonymous
// classes both work.
const { initComponent } = require('./JComponent.js');
const eventDispatch = require('../../java/awt/eventDispatch.js');

const ACTION_PERFORMED = 1001;

function initButton(jvm, obj, text) {
  initComponent(jvm, obj, 'button');
  obj._text = text || '';
  obj._actionCommand = null;
  obj._actionListeners = [];
  const element = obj._awtElement;
  if (element) {
    element.type = 'button';
    element.addEventListener('click', () => {
      if (obj._enabled === false) return;
      fireAction(jvm, obj).then(() => jvm.resumeForHostEvent(), (error) => {
        console.error('Swing button action dispatch failed:', error);
      });
    });
  }
  render(obj);
}

function render(obj) {
  if (obj._awtElement) obj._awtElement.textContent = String(obj._text || '');
}

function actionEvent(obj) {
  return {
    type: 'java/awt/event/ActionEvent',
    source: obj,
    id: ACTION_PERFORMED,
    command: obj._actionCommand != null ? obj._actionCommand : (obj._text || ''),
    when: BigInt(Date.now()),
    modifiers: 0,
  };
}

async function fireAction(jvm, obj) {
  const event = actionEvent(obj);
  for (const listener of [...(obj._actionListeners || [])]) {
    await eventDispatch.invokeLater(jvm, listener, 'actionPerformed',
      '(Ljava/awt/event/ActionEvent;)V', [event]);
  }
}

module.exports = {
  super: 'javax/swing/JComponent',
  interfaces: ['javax/swing/SwingConstants', 'java/awt/ItemSelectable'],
  initButton,
  fireAction,
  methods: {
    '<init>()V': (jvm, obj) => initButton(jvm, obj, ''),
    'getText()Ljava/lang/String;': (jvm, obj) => obj._text || '',
    'setText(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj._text = args[0] || '';
      render(obj);
    },
    'getLabel()Ljava/lang/String;': (jvm, obj) => obj._text || '',
    'setLabel(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj._text = args[0] || '';
      render(obj);
    },
    'getActionCommand()Ljava/lang/String;': (jvm, obj) =>
      (obj._actionCommand != null ? obj._actionCommand : (obj._text || '')),
    'setActionCommand(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj._actionCommand = args[0];
    },
    'addActionListener(Ljava/awt/event/ActionListener;)V': (jvm, obj, args) => {
      const listener = args[0];
      if (listener && !obj._actionListeners.includes(listener)) {
        obj._actionListeners.push(listener);
      }
    },
    'removeActionListener(Ljava/awt/event/ActionListener;)V': (jvm, obj, args) => {
      const index = obj._actionListeners.indexOf(args[0]);
      if (index !== -1) obj._actionListeners.splice(index, 1);
    },
    // Swing runs doClick() listeners synchronously on the calling thread.
    'doClick()V': async (jvm, obj, args, thread) => {
      if (obj._enabled === false) return;
      const event = actionEvent(obj);
      const frames = [];
      for (const listener of obj._actionListeners) {
        const frame = await eventDispatch.callbackFrame(jvm, listener,
          'actionPerformed', '(Ljava/awt/event/ActionEvent;)V', [event]);
        if (frame) frames.push(frame);
      }
      const target = thread || jvm.threads[jvm.currentThreadIndex];
      for (let i = frames.length - 1; i >= 0; i--) target.callStack.push(frames[i]);
    },
  },
};
