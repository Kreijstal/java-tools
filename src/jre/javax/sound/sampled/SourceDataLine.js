module.exports = {
  'javax/sound/sampled/SourceDataLine': {
    super: 'javax/sound/sampled/DataLine',
    methods: {
      'open(Ljavax/sound/sampled/AudioFormat;I)V': (jvm, obj, args) => {
        // abstract method
      },
      'open(Ljavax/sound/sampled/AudioFormat;)V': (jvm, obj, args) => {
        // abstract method
      },
      'write([BII)I': (jvm, obj, args) => {
        // abstract method
        return 0;
      },
      'available()I': (jvm, obj, args) => {
        // abstract method
        return 0;
      },
      'flush()V': (jvm, obj, args) => {
        // abstract method
      },
      'start()V': (jvm, obj, args) => {
        // abstract method
      },
    },
  },
};
