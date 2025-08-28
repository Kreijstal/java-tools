module.exports = {
  super: {
    type: 'java/lang/annotation/Annotation'
  },
  methods: {
    '<init>([Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.value = args[0] || ['unchecked'];
    },
    'value()[Ljava/lang/String;': (jvm, obj, args) => {
      return obj.value;
    }
  },
  staticFields: {},
  interfaces: ['java/lang/annotation/Annotation']
};