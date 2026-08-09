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
      const key = name || String(container._cardOrder.length);
      if (!(key in container._cards)) container._cardOrder.push(key);
      container._cards[key] = component;
      if (container._currentCard == null) container._currentCard = key;
    },
    'show(Ljava/awt/Container;Ljava/lang/String;)V': (jvm, obj, args) => {
      const container = args[0];
      const name = normalizeCardName(args[1]);
      if (!container || !container._cards || !(name in container._cards)) return;
      container._currentCard = name;
      layoutContainer(jvm, container);
    },
    'first(Ljava/awt/Container;)V': (jvm, obj, args) => {
      const container = args[0];
      if (container && container._cardOrder && container._cardOrder.length) {
        container._currentCard = container._cardOrder[0];
        layoutContainer(jvm, container);
      }
    },
    'last(Ljava/awt/Container;)V': (jvm, obj, args) => {
      const container = args[0];
      if (container && container._cardOrder && container._cardOrder.length) {
        container._currentCard = container._cardOrder[container._cardOrder.length - 1];
        layoutContainer(jvm, container);
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

function layoutContainer(jvm, container) {
  const doLayout = jvm._jreFindMethod(
    'java/awt/Container', 'doLayout', '()V');
  if (doLayout) doLayout(jvm, container, []);
}
