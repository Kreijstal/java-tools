module.exports = {
  super: 'java/awt/AWTEvent',
  // Values from the JDK's public static final fields.
  staticFields: {
    'COMPONENT_FIRST:I': 100,
    'COMPONENT_LAST:I': 103,
    'COMPONENT_MOVED:I': 100,
    'COMPONENT_RESIZED:I': 101,
    'COMPONENT_SHOWN:I': 102,
    'COMPONENT_HIDDEN:I': 103,
  },
  methods: {
    '<init>()V': () => {},
    'getComponent()Ljava/awt/Component;': (jvm, obj, args) => obj.component || obj.source || null,
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => obj.source || obj.component || null,
  },
};
