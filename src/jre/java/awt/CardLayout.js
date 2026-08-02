// java.awt.CardLayout - Shows one component ("card") of a container at a time

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/awt/LayoutManager'],
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._hgap = 0;
      obj._vgap = 0;
    },
    '<init>(II)V': (jvm, obj, args) => {
      obj._hgap = args[0] || 0;
      obj._vgap = args[1] || 0;
    },
    // Cards are registered on the container: _cards = { name -> component }
    'addLayoutComponent(Ljava/awt/Component;Ljava/lang/Object;)V': (jvm, obj, args) => {
      const component = args[0];
      const name = normalizeCardName(args[1]);
      const container = component && component._parent;
      if (!container) return;
      container._cards = container._cards || {};
      container._cardOrder = container._cardOrder || [];
      if (name && !(name in container._cards)) {
        container._cardOrder.push(name);
      }
      container._cards[name || String(container._cardOrder.length)] = component;
      if (!container._currentCard) {
        container._currentCard = name || String(container._cardOrder.length);
      }
    },
    'show(Ljava/awt/Container;Ljava/lang/String;)V': (jvm, obj, args) => {
      const container = args[0];
      const name = normalizeCardName(args[1]);
      if (!container) return;
      container._currentCard = name;
      // Re-run the container layout so only the active card is visible
      const doLayout = jvm.findMethod(
        jvm.classes['java/awt/Container'],
        'doLayout',
        '()V',
      );
      if (doLayout && !(jvm.overrides && jvm.overrides['java/awt/Container'] &&
          jvm.overrides['java/awt/Container'].methods &&
          jvm.overrides['java/awt/Container'].methods['doLayout()V'])) {
        // execute synchronously via direct call
      }
      if (container.doLayout) {
        container.doLayout(jvm, container, []);
      }
    },
    'first(Ljava/awt/Container;)V': (jvm, obj, args) => {
      const container = args[0];
      if (container && container._cardOrder && container._cardOrder.length) {
        container._currentCard = container._cardOrder[0];
      }
    },
    'last(Ljava/awt/Container;)V': (jvm, obj, args) => {
      const container = args[0];
      if (container && container._cardOrder && container._cardOrder.length) {
        container._currentCard = container._cardOrder[container._cardOrder.length - 1];
      }
    },
  },
};

function normalizeCardName(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value.value != null) return String(value.value);
  return String(value);
}
