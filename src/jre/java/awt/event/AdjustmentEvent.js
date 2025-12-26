module.exports = {
  super: 'java/lang/Object',
  methods: {
    'getValue()I': (jvm, obj, args) => {
      return obj.value || 0;
    },
    'getSource()Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.source || null;
    }
  },
};
