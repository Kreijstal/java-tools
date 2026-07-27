const { createAudioOutput } = require('../../../../platform/audio');
const { withThrows } = require('../../../helpers');

function getFormatFields(format) {
  return format.fields["javax/sound/sampled/AudioFormat"];
}

function toOutputOptions(formatFields, bufferSize) {
  return {
    channels: formatFields.channels || 1,
    bitDepth: formatFields.sampleSizeInBits || 16,
    sampleRate: formatFields.sampleRate || 44100,
    signed: formatFields.signed !== undefined ? formatFields.signed : true,
    bigEndian: formatFields.bigEndian !== undefined ? formatFields.bigEndian : false,
    bufferSize: Number.isFinite(bufferSize) && bufferSize > 0
      ? bufferSize
      : 4096,
  };
}

function toAudioBytes(buffer, offset, len) {
  const slice = buffer.slice(offset, offset + len);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(slice);
  }
  return new Uint8Array(slice);
}

function openWithFormat(obj, format) {
  const formatFields = format &&
    format.fields &&
    getFormatFields(format);
  if (!formatFields) {
    throw {
      type: "javax/sound/sampled/LineUnavailableException",
      message: "SourceDataLine has no negotiated audio format",
    };
  }

  try {
    obj.audioOutput = createAudioOutput(
      toOutputOptions(formatFields, obj.requestedBufferSize),
    );
    obj.isOpen = true;
    obj.requestedFormat = format;
  } catch (error) {
    // Headless / no audio device: discard samples instead of leaving the
    // line closed — games treat a dead line as fatal mid-loop.
    if (!module.exports._warnedNoAudio) {
      module.exports._warnedNoAudio = true;
      console.error("No audio device, discarding sound output:", error.message);
    }
    obj.audioOutput = {
      write() {},
      once(event, cb) { if (cb) cb(); },
      end() {},
    };
    obj.isOpen = true;
  }
}

module.exports = {
  super: "javax/sound/sampled/DataLine",
  methods: {
    "open()V": withThrows((jvm, obj) => {
      openWithFormat(obj, obj.requestedFormat);
    }, ["javax/sound/sampled/LineUnavailableException"]),
    "open(Ljavax/sound/sampled/AudioFormat;)V": withThrows((jvm, obj, args) => {
      const [format] = args;
      openWithFormat(obj, format);
    }, ["javax/sound/sampled/LineUnavailableException"]),
    "open(Ljavax/sound/sampled/AudioFormat;I)V": (jvm, obj, args) => {
      obj.requestedBufferSize = Number(args[1]);
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
      // A discard sink drains instantaneously. Reporting it as permanently
      // empty makes games spend every cycle decoding audio that nobody can
      // hear. In explicitly headless mode, model a full output buffer so the
      // producer applies normal backpressure and yields to rendering.
      const audioDisabled = typeof process !== "undefined" && process.env &&
        (process.env.JVM_DISABLE_AUDIO === "1" ||
          process.env.JVM_DISABLE_AUDIO === "true");
      if (audioDisabled) {
        return 0;
      }
      if (obj.audioOutput && typeof obj.audioOutput.available === "function") {
        return Math.max(0, Number(obj.audioOutput.available()) | 0);
      }
      return Number.isFinite(obj.requestedBufferSize) &&
        obj.requestedBufferSize > 0
        ? obj.requestedBufferSize | 0
        : 4096;
    },
    "flush()V": (jvm, obj, args) => {
      if (obj.audioOutput && typeof obj.audioOutput.flush === "function") {
        obj.audioOutput.flush();
      }
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
