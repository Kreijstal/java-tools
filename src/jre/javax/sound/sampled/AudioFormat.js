const { readField, writeField } = require('../../../../core/objectModel');
module.exports = {
  super: 'java/lang/Object',
  fields: {
    'sampleRate': 'F',
    'sampleSizeInBits': 'I',
    'channels': 'I',
    'signed': 'Z',
    'bigEndian': 'Z',
  },
  methods: {
    '<init>(FIIZZ)V': (jvm, obj, args) => {
      const [sampleRate, sampleSizeInBits, channels, signed, bigEndian] = args;
      writeField(obj.fields, 'javax/sound/sampled/AudioFormat', {
        sampleRate,
        sampleSizeInBits,
        channels,
        signed,
        bigEndian,
      });
    },
  },
};
