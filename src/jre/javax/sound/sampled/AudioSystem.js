const { withThrows } = require('../../../helpers');
const { newJavaObject, getLineForInfo, isSourceDataLineInfo } =
  require('./lineSupport');

// getMixerInfo() previously returned null, which no JRE ever does: the
// contract is an array, empty at worst. Guest code loops over the result
// without a null check -- regression corpus scans it for a "soundmax" substring --
// so null turns a device query into a NullPointerException in the guest.
//
// Reporting zero mixers would be just as misleading in the other direction:
// games read an empty list as "this machine has no sound card" and disable
// audio outright. So advertise exactly one output device, and make the mixer
// path actually reach a line rather than dead-ending in an unimplemented
// method.
//
// The name is the historical JRE default on purpose. Games of this vintage
// sniff the mixer list for particular substrings to work around driver bugs;
// an unfamiliar name is a guest-visible behaviour change with nothing to gain.
const MIXER_NAME = 'Java Sound Audio Engine';
const MIXER_VENDOR = 'jvm.js';
const MIXER_DESCRIPTION = 'Software mixer backed by the jvm.js audio platform';
const MIXER_VERSION = '1.0';

// Cached so repeated calls return the same instance: guest code compares
// Mixer.Info identity with == when picking a device back out of the list.
function sharedMixerInfo(jvm) {
  if (!jvm.__sampledMixerInfo) {
    jvm.__sampledMixerInfo = newJavaObject(
      jvm,
      'javax/sound/sampled/Mixer$Info',
      {
        'javax/sound/sampled/Mixer$Info': {
          name: jvm.internString(MIXER_NAME),
          vendor: jvm.internString(MIXER_VENDOR),
          description: jvm.internString(MIXER_DESCRIPTION),
          version: jvm.internString(MIXER_VERSION),
        },
      },
    );
  }
  return jvm.__sampledMixerInfo;
}

function sharedMixer(jvm) {
  if (!jvm.__sampledMixer) {
    jvm.__sampledMixer = newJavaObject(jvm, 'javax/sound/sampled/Mixer');
    jvm.__sampledMixer.mixerInfo = sharedMixerInfo(jvm);
  }
  return jvm.__sampledMixer;
}

module.exports = {
  super: "java/lang/Object",
  staticMethods: {
    "getLine(Ljavax/sound/sampled/Line$Info;)Ljavax/sound/sampled/Line;": withThrows((
      jvm,
      obj,
      args,
    ) => getLineForInfo(jvm, args[0]),
    ['javax/sound/sampled/LineUnavailableException']),
    "getMixerInfo()[Ljavax/sound/sampled/Mixer$Info;": (jvm) => ({
      type: '[Ljavax/sound/sampled/Mixer$Info;',
      length: 1,
      elements: [sharedMixerInfo(jvm)],
    }),
    "getMixer(Ljavax/sound/sampled/Mixer$Info;)Ljavax/sound/sampled/Mixer;": (
      jvm,
    ) => sharedMixer(jvm),
    "isLineSupported(Ljavax/sound/sampled/Line$Info;)Z": (jvm, obj, args) =>
      isSourceDataLineInfo(args[0]) ? 1 : 0,
  },
};
