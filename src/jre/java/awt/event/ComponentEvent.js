module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
    'getComponent()Ljava/awt/Component;': (jvm, obj, args) => obj.component || obj.source || null,
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => obj.source || obj.component || null,
  },
};
