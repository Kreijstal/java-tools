module.exports = {
  super: 'java/awt/AWTEvent',
  // Values from the JDK's public static final fields.
  staticFields: {
    'ITEM_FIRST:I': 701,
    'ITEM_LAST:I': 701,
    'ITEM_STATE_CHANGED:I': 701,
    'SELECTED:I': 1,
    'DESELECTED:I': 2,
  },
  methods: {
    '<init>()V': () => {},
    'getItemSelectable()Ljava/awt/ItemSelectable;': (jvm, obj, args) => obj.itemSelectable || obj.source || null,
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => obj.source || obj.itemSelectable || null,
  },
};
