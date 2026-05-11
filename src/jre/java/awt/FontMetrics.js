module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
    'stringWidth(Ljava/lang/String;)I': (jvm, obj, args) => String(args[0] || '').length * 7,
    'getHeight()I': () => 12,
    'getAscent()I': () => 10,
    'getDescent()I': () => 2,
  },
};
