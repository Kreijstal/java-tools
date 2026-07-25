module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'DEFAULT_CURSOR:I': 0,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._type = 0;
    },
    '<init>(I)V': (jvm, obj, args) => {
      obj._type = args[0] || 0;
    },
  },
  staticMethods: {
    'getDefaultCursor()Ljava/awt/Cursor;': () => ({ type: 'java/awt/Cursor', _type: 0 }),
  },
};
