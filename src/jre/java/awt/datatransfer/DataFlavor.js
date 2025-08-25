module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'stringFlavor:Ljava/awt/datatransfer/DataFlavor;': {
      type: 'java/awt/datatransfer/DataFlavor',
      value: null, // Initialized in clinit
    },
  },
  methods: {
    '<clinit>()V': (jvm, _, args) => {
      const dataFlavorClass = jvm.classes['java/awt/datatransfer/DataFlavor'];
      const stringFlavor = {
        type: 'java/awt/datatransfer/DataFlavor',
        mimeType: 'application/x-java-serialized-object; class=java.lang.String',
      };
      dataFlavorClass.staticFields.set('stringFlavor:Ljava/awt/datatransfer/DataFlavor;', stringFlavor);
    },
  },
};
