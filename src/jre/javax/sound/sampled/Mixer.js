const { withThrows } = require('../../../helpers');
const { getLineForInfo, isSourceDataLineInfo } = require('./lineSupport');

// Mixer is an interface in Java, but AudioSystem.getMixer() now hands back a
// concrete object, so the methods a client reaches through it have to exist.
// Everything routes to the same line factory AudioSystem.getLine() uses --
// there is one output device, so picking it explicitly changes nothing.
module.exports = {
  // An interface in the JDK. The flag is what makes the Java frontend choose
  // invokeinterface over invokevirtual, and a Methodref naming an interface links
  // cleanly and then throws IncompatibleClassChangeError the first time it runs.
  isInterface: true,
  super: 'javax/sound/sampled/Line',
  methods: {
    'getLine(Ljavax/sound/sampled/Line$Info;)Ljavax/sound/sampled/Line;':
      withThrows((jvm, obj, args) => getLineForInfo(jvm, args[0]),
        ['javax/sound/sampled/LineUnavailableException']),
    'isLineSupported(Ljavax/sound/sampled/Line$Info;)Z': (jvm, obj, args) =>
      isSourceDataLineInfo(args[0]) ? 1 : 0,
    'getMixerInfo()Ljavax/sound/sampled/Mixer$Info;': (jvm, obj) =>
      obj.mixerInfo || null,
    'getMaxLines(Ljavax/sound/sampled/Line$Info;)I': (jvm, obj, args) =>
      // Unlimited, as the software mixer imposes no hardware voice limit.
      isSourceDataLineInfo(args[0]) ? -1 : 0,
    'open()V': (jvm, obj) => {
      obj.isOpen = true;
    },
    'close()V': (jvm, obj) => {
      obj.isOpen = false;
    },
    'isOpen()Z': (jvm, obj) => (obj.isOpen ? 1 : 0),
  },
};
