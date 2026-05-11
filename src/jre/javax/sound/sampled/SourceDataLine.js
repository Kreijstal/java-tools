const { createAudioOutput } = require('../../../../platform/audio');
const { withThrows } = require('../../../helpers');

function getFormatFields(format) {
  return format.fields["javax/sound/sampled/AudioFormat"];
}

function toOutputOptions(formatFields) {
  return {
    channels: formatFields.channels || 1,
    bitDepth: formatFields.sampleSizeInBits || 16,
    sampleRate: formatFields.sampleRate || 44100,
    signed: formatFields.signed !== undefined ? formatFields.signed : true,
    bigEndian: formatFields.bigEndian !== undefined ? formatFields.bigEndian : false,
  };
}

function toAudioBytes(buffer, offset, len) {
  const slice = buffer.slice(offset, offset + len);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(slice);
  }
  return new Uint8Array(slice);
}

module.exports = {
  super: "javax/sound/sampled/DataLine",
  methods: {
    "open(Ljavax/sound/sampled/AudioFormat;)V": withThrows((jvm, obj, args) => {
      const [format] = args;
      const formatFields = getFormatFields(format);

      try {
        obj.audioOutput = createAudioOutput(toOutputOptions(formatFields));
        obj.isOpen = true;
      } catch (error) {
        console.error("Failed to open audio device:", error.message);
        throw {
          type: "javax/sound/sampled/LineUnavailableException",
          message: "Failed to open audio device: " + error.message,
        };
      }
    }, ["javax/sound/sampled/LineUnavailableException"]),
    "open(Ljavax/sound/sampled/AudioFormat;I)V": (jvm, obj, args) => {
      // bufferSize is ignored for now
      const self = jvm.jre["javax/sound/sampled/SourceDataLine"];
      self.methods["open(Ljavax/sound/sampled/AudioFormat;)V"](jvm, obj, args);
    },
    "write([BII)I": withThrows((jvm, obj, args) => {
      const [buffer, offset, len] = args;

      if (!obj.audioOutput || !obj.isOpen) {
        throw {
          type: "java/lang/IllegalStateException",
          message: "Line is not open",
        };
      }

      try {
        obj.audioOutput.write(toAudioBytes(buffer, offset, len));
        return len;
      } catch (error) {
        console.error("Audio write error:", error.message);
        throw {
          type: "java/io/IOException",
          message: "Audio write failed: " + error.message,
        };
      }
    }, ["java/lang/IllegalStateException", "java/io/IOException"]),
    "available()I": (jvm, obj, args) => {
      // Return a reasonable buffer size estimate
      return 4096;
    },
    "flush()V": (jvm, obj, args) => {
      // Data is sent immediately by the current audio outputs.
    },
    "start()V": (jvm, obj, args) => {
      // Audio outputs start automatically on first write.
      obj.isStarted = true;
    },
    "stop()V": (jvm, obj, args) => {
      obj.isStarted = false;
    },
    "drain()V": async (jvm, obj, args) => {
      if (!obj.audioOutput) {
        return;
      }

      await new Promise((resolve) => {
        obj.audioOutput.once("drain", resolve);
      });
    },
    "close()V": (jvm, obj, args) => {
      if (obj.audioOutput) {
        try {
          obj.audioOutput.end();
        } catch (error) {
          console.error("Error closing audio output:", error.message);
        }
        obj.audioOutput = null;
      }
      obj.isOpen = false;
      obj.isStarted = false;
    },
    "isOpen()Z": (jvm, obj, args) => {
      return obj.isOpen ? 1 : 0;
    },
    "isActive()Z": (jvm, obj, args) => {
      return obj.isStarted ? 1 : 0;
    },
  },
};
