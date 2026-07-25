module.exports = {
  super: 'java/awt/AWTEvent',
  methods: {
    '<init>()V': () => {},
    '<init>(Ljava/lang/Object;ILjava/lang/String;)V': (jvm, obj, args) => {
      obj.source = args[0];
      obj.id = args[1] | 0;
      obj.command = args[2];
      obj.when = 0n;
      obj.modifiers = 0;
    },
    '<init>(Ljava/lang/Object;ILjava/lang/String;I)V': (jvm, obj, args) => {
      obj.source = args[0];
      obj.id = args[1] | 0;
      obj.command = args[2];
      obj.when = 0n;
      obj.modifiers = args[3] | 0;
    },
    '<init>(Ljava/lang/Object;ILjava/lang/String;JI)V': (jvm, obj, args) => {
      obj.source = args[0];
      obj.id = args[1] | 0;
      obj.command = args[2];
      obj.when = args[3];
      obj.modifiers = args[4] | 0;
    },
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => obj.source || null,
    'getActionCommand()Ljava/lang/String;': (jvm, obj) => obj.command || null,
    'getWhen()J': (jvm, obj) => obj.when || 0n,
    'getModifiers()I': (jvm, obj) => obj.modifiers || 0,
  },
};
