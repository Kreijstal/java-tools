const defaultToolkit = { type: 'java/awt/Toolkit' };

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
    'getScreenSize()Ljava/awt/Dimension;': () => ({
      type: 'java/awt/Dimension',
      width: 800,
      height: 600,
      fields: {
        'java/awt/Dimension.width': 800,
        'java/awt/Dimension.height': 600,
      },
    }),
    'getSystemClipboard()Ljava/awt/datatransfer/Clipboard;': (jvm, obj) => (
      obj._systemClipboard || { type: 'java/awt/datatransfer/Clipboard' }
    ),
    'getSystemEventQueue()Ljava/awt/EventQueue;': (jvm, obj) => (
      obj._systemEventQueue || { type: 'java/awt/EventQueue' }
    ),
    'createImage([B)Ljava/awt/Image;': () => ({ type: 'java/awt/Image' }),
    'createCustomCursor(Ljava/awt/Image;Ljava/awt/Point;Ljava/lang/String;)Ljava/awt/Cursor;': () => ({ type: 'java/awt/Cursor' }),
  },
  staticMethods: {
    'getDefaultToolkit()Ljava/awt/Toolkit;': () => defaultToolkit,
  },
};
