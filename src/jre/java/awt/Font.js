module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'PLAIN:I': 0,
    'BOLD:I': 1,
    'ITALIC:I': 2,
  },
  methods: {
    '<init>(Ljava/lang/String;II)V': (jvm, obj, args) => {
      obj._name = args[0] == null ? null : String(args[0]);
      obj._style = args[1];
      obj._size = args[2];
    },
    'getName()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj._name || 'Dialog'),
    'getStyle()I': (jvm, obj) => obj._style | 0,
    'getSize()I': (jvm, obj) => obj._size | 0,
  },
};
