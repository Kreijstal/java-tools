module.exports = {
  // An interface in the JDK (annotation types are interfaces too); see the note in
  // javax/sound/sampled/Line.js for why the flag matters.
  isInterface: true,
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