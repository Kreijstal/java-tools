module.exports = {
  super: 'java/awt/AWTEvent',
  methods: {
    '<init>()V': () => {},
    'getComponent()Ljava/awt/Component;': (jvm, obj, args) => obj.component || obj.source || null,
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => obj.source || obj.component || null,
  },
};
