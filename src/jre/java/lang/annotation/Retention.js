module.exports = {
  super: {
    type: 'java/lang/annotation/Annotation'
  },
  methods: {
    '<init>(Ljava/lang/annotation/RetentionPolicy;)V': (jvm, obj, args) => {
      obj.value = args[0];
    },
    'value()Ljava/lang/annotation/RetentionPolicy;': (jvm, obj, args) => {
      return obj.value;
    }
  },
  staticFields: {},
  interfaces: ['java/lang/annotation/Annotation']
};