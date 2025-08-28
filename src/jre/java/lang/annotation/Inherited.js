module.exports = {
  super: {
    type: 'java/lang/annotation/Annotation'
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Inherited annotation - indicates that annotations will be inherited by subclasses
    }
  },
  staticFields: {},
  interfaces: ['java/lang/annotation/Annotation']
};