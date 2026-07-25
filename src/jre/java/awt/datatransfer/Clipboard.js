module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getContents(Ljava/lang/Object;)Ljava/awt/datatransfer/Transferable;': (jvm, obj) => obj._contents || null,
    'setContents(Ljava/awt/datatransfer/Transferable;Ljava/awt/datatransfer/ClipboardOwner;)V': (jvm, obj, args) => {
      obj._contents = args[0] || null;
      obj._owner = args[1] || null;
    },
  },
};
