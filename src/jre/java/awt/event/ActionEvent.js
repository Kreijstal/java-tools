module.exports = {
  super: 'java/awt/AWTEvent',
  methods: {
    '<init>()V': () => {},
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => obj.source || null,
  },
};
