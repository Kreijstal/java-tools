let Speaker;
try {
  Speaker = require('speaker');
} catch (err) {
  // Fallback for environments where speaker package is not available
  console.warn('Speaker package not available, audio output disabled');
  Speaker = class MockSpeaker {
    constructor(options) {
      this.options = options;
    }
    write(data) {
      // Mock write - do nothing
    }
    end() {
      // Mock end - do nothing
    }
    once(event, callback) {
      if (event === 'drain') {
        setTimeout(callback, 0);
      }
    }
  };
}

module.exports = {
  super: 'javax/sound/sampled/DataLine',
  methods: {
    'open(Ljavax/sound/sampled/AudioFormat;)V': (jvm, obj, args) => {
      const [format] = args;
      const formatFields = format.fields['javax/sound/sampled/AudioFormat'];

      const speaker = new Speaker({
        channels: formatFields.channels,
        bitDepth: formatFields.sampleSizeInBits,
        sampleRate: formatFields.sampleRate,
        signed: formatFields.signed,
        device: 'null',
      });

      obj.speaker = speaker;
    },
    'open(Ljavax/sound/sampled/AudioFormat;I)V': (jvm, obj, args) => {
      // bufferSize is ignored for now
      const self = jvm.jre['javax/sound/sampled/SourceDataLine'];
      self.methods['open(Ljavax/sound/sampled/AudioFormat;)V'](jvm, obj, args);
    },
    'write([BII)I': (jvm, obj, args) => {
      const [buffer, offset, len] = args;
      const data = Buffer.from(buffer.slice(offset, offset + len));
      obj.speaker.write(data);
      return len;
    },
    'available()I': (jvm, obj, args) => {
      // Not implemented
      return 0;
    },
    'flush()V': (jvm, obj, args) => {
      // Not implemented
    },
    'start()V': (jvm, obj, args) => {
      // Not needed, speaker starts on first write
    },
    'drain()V': async (jvm, obj, args) => {
      await new Promise(resolve => {
        obj.speaker.once('drain', resolve);
      });
    },
    'close()V': (jvm, obj, args) => {
      obj.speaker.end();
    },
  },
};
