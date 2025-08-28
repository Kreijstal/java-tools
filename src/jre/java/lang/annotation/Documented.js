module.exports = {
  super: {
    type: 'java/lang/annotation/Annotation'
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Documented annotation - used to indicate that an annotation should be included in generated documentation
    }
  },
  staticFields: {},
  interfaces: ['java/lang/annotation/Annotation']
};