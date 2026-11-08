module.exports = {
  super: 'java/awt/AWTEvent',
  // Values from the JDK's public static final fields.
  staticFields: {
    'ADJUSTMENT_FIRST:I': 601,
    'ADJUSTMENT_LAST:I': 601,
    'ADJUSTMENT_VALUE_CHANGED:I': 601,
    'UNIT_INCREMENT:I': 1,
    'UNIT_DECREMENT:I': 2,
    'BLOCK_DECREMENT:I': 3,
    'BLOCK_INCREMENT:I': 4,
    'TRACK:I': 5,
  },
  methods: {
    'getValue()I': (jvm, obj, args) => {
      return obj.value || 0;
    },
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.source || null;
    }
  },
};
