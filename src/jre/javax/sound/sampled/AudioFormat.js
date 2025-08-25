module.exports = {
  'javax/sound/sampled/AudioFormat': {
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
        const fields = obj.fields['javax/sound/sampled/AudioFormat'];
        fields['sampleRate'] = sampleRate;
        fields['sampleSizeInBits'] = sampleSizeInBits;
        fields['channels'] = channels;
        fields['signed'] = signed;
        fields['bigEndian'] = bigEndian;
      },
    },
  },
};
