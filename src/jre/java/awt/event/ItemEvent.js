module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
    'getItemSelectable()Ljava/awt/ItemSelectable;': (jvm, obj, args) => obj.itemSelectable || obj.source || null,
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => obj.source || obj.itemSelectable || null,
  },
};
