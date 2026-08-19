module.exports = {
  // An interface in the JDK (annotation types are interfaces too); see the note in
  // javax/sound/sampled/Line.js for why the flag matters.
  isInterface: true,
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