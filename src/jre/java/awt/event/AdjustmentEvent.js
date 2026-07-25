module.exports = {
  super: 'java/awt/AWTEvent',
  methods: {
    'getValue()I': (jvm, obj, args) => {
      return obj.value || 0;
    },
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.source || null;
    }
  },
};
