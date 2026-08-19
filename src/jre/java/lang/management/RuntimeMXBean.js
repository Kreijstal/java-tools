module.exports = {
  // An interface in the JDK (annotation types are interfaces too); see the note in
  // javax/sound/sampled/Line.js for why the flag matters.
  isInterface: true,
  super: 'java/lang/Object',
  methods: {
    'getSpecVersion()Ljava/lang/String;': (jvm) => jvm.internString('1.8'),
  },
};
