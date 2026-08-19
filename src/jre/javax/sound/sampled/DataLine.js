module.exports = {
  // An interface in the JDK. The flag is what makes the Java frontend choose
  // invokeinterface over invokevirtual, and a Methodref naming an interface links
  // cleanly and then throws IncompatibleClassChangeError the first time it runs.
  isInterface: true,
  super: 'javax/sound/sampled/Line',
  methods: {
    // DataLine is an interface, so methods are abstract
  },
};
