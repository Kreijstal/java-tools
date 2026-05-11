module.exports = {
  super: 'java/awt/Component',
  interfaces: ['java/awt/ItemSelectable'],
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._items = [];
      obj._selectedIndex = -1;
      obj._itemListeners = [];
    },
    'add(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj._items = obj._items || [];
      obj._items.push(args[0] || '');
      if (obj._selectedIndex < 0) obj._selectedIndex = 0;
    },
    'addItem(Ljava/lang/String;)V': (jvm, obj, args) => {
      const add = jvm._jreFindMethod('java/awt/Choice', 'add', '(Ljava/lang/String;)V');
      add(jvm, obj, args);
    },
    'removeAll()V': (jvm, obj, args) => {
      obj._items = [];
      obj._selectedIndex = -1;
    },
    'select(I)V': (jvm, obj, args) => {
      const index = args[0] || 0;
      obj._selectedIndex = Math.max(0, Math.min(index, (obj._items || []).length - 1));
    },
    'getSelectedIndex()I': (jvm, obj, args) => obj._selectedIndex == null ? -1 : obj._selectedIndex,
    'getSelectedItem()Ljava/lang/String;': (jvm, obj, args) => {
      const items = obj._items || [];
      return items[obj._selectedIndex] || null;
    },
    'addItemListener(Ljava/awt/event/ItemListener;)V': (jvm, obj, args) => addListener(obj, args[0]),
    'removeItemListener(Ljava/awt/event/ItemListener;)V': (jvm, obj, args) => removeListener(obj, args[0]),
  },
};

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
