module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
    'getX()I': (jvm, obj, args) => obj.x || 0,
    'getY()I': (jvm, obj, args) => obj.y || 0,
    'getModifiers()I': (jvm, obj, args) => obj.modifiers || 0,
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => obj.source || null,
  },
};
