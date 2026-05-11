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
  },
  staticMethods: {
    'getDefaultToolkit()Ljava/awt/Toolkit;': () => defaultToolkit,
  },
};
