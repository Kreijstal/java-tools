module.exports = {
  super: {
    type: 'java/lang/annotation/Annotation'
  },
  methods: {
    '<init>([Ljava/lang/annotation/ElementType;)V': (jvm, obj, args) => {
      obj.value = args[0] || [];
    },
    'value()[Ljava/lang/annotation/ElementType;': (jvm, obj, args) => {
      return obj.value;
    }
  },
  staticFields: {},
  interfaces: ['java/lang/annotation/Annotation']
};