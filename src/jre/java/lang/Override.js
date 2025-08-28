module.exports = {
  super: {
    type: 'java/lang/annotation/Annotation'
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Override annotation - indicates that a method overrides a supertype method
    }
  },
  staticFields: {},
  interfaces: ['java/lang/annotation/Annotation']
};