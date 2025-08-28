module.exports = {
  super: {
    type: 'java/lang/annotation/Annotation'
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // SafeVarargs annotation constructor
    }
  },
  staticFields: {},
  interfaces: ['java/lang/annotation/Annotation']
};