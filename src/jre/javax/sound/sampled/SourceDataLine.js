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

// Neither backend can report buffer occupancy: MockAudioOutput discards the
// payload and node's `speaker` is a plain stream. Without a model of the drain,
// available() reports a permanently empty buffer, the guest's own throttle
// never engages, and the audio pump spins -- on Tomb Racer that inflated the
// pump from 5.7k to 920k calls and post-logo loading by 2.4x. Model the line
// draining at its own sample rate so the producer sees real backpressure while
// the samples still reach the device.
function createDrainModel(options) {
  const bytesPerFrame = Math.max(
    1,
    Math.ceil((options.bitDepth || 16) / 8) * (options.channels || 1),
  );
  const bytesPerSecond = Math.max(
    1,
    Math.round((options.sampleRate || 44100) * bytesPerFrame),
  );
  const capacity = Number.isFinite(options.bufferSize) && options.bufferSize > 0
    ? options.bufferSize
    : 4096;
  let queued = 0;
  let lastMillis = null;

  function advance(nowMillis) {
    if (!Number.isFinite(nowMillis)) return;
    if (lastMillis === null) {
      lastMillis = nowMillis;
      return;
    }
    const elapsed = nowMillis - lastMillis;
    if (elapsed <= 0) return;
    lastMillis = nowMillis;
    queued = Math.max(0, queued - (elapsed / 1000) * bytesPerSecond);
  }

  return {
    capacity,
    accept(nowMillis, len) {
      advance(nowMillis);
      queued = Math.min(capacity, queued + Math.max(0, len));
    },
    available(nowMillis) {
      advance(nowMillis);
      return Math.max(0, Math.floor(capacity - queued));
    },
    reset(nowMillis) {
      lastMillis = Number.isFinite(nowMillis) ? nowMillis : null;
      queued = 0;
    },
  };
}

function nowMillis(jvm) {
  if (jvm && jvm.clock && typeof jvm.clock.millis === "function") {
    return Number(jvm.clock.millis());
  }
  return Date.now();
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

  const outputOptions = toOutputOptions(formatFields, obj.requestedBufferSize);
  obj.drainModel = createDrainModel(outputOptions);

  try {
    obj.audioOutput = createAudioOutput(outputOptions);
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
  // An interface in the JDK. The flag is what makes the Java frontend choose
  // invokeinterface over invokevirtual, and a Methodref naming an interface links
  // cleanly and then throws IncompatibleClassChangeError the first time it runs.
  isInterface: true,
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
    "write([BII)I": withThrows((jvm, obj, args, thread) => {
      const [buffer, offset, len] = args;

      if (!obj.audioOutput || !obj.isOpen) {
        throw {
          type: "java/lang/IllegalStateException",
          message: "Line is not open",
        };
      }

      try {
        if (obj.audioOutput.acceptsGuestByteArraySlices === true) {
          obj.audioOutput.write(buffer, offset, len);
        } else {
          obj.audioOutput.write(toAudioBytes(buffer, offset, len));
        }
        if (obj.drainModel) {
          obj.drainModel.accept(nowMillis(jvm), len);
        }
        if (thread && obj.audioOutput &&
            typeof obj.audioOutput.queuedSeconds === "function" &&
            obj.audioOutput.context?.state !== "suspended" &&
            obj.audioOutput.queuedSeconds() < 0.04) {
          jvm._audioPriority = {
            thread,
            output: obj.audioOutput,
            until: jvm.clock.millis() + 50,
          };
        }
        return len;
      } catch (error) {
        console.error("Audio write error:", error.message);
        throw {
          type: "java/io/IOException",
          message: "Audio write failed: " + error.message,
        };
      }
    }, ["java/lang/IllegalStateException", "java/io/IOException"], []),
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
      if (obj.drainModel) {
        return obj.drainModel.available(nowMillis(jvm)) | 0;
      }
      return Number.isFinite(obj.requestedBufferSize) &&
        obj.requestedBufferSize > 0
        ? obj.requestedBufferSize | 0
        : 4096;
    },
    "flush()V": (jvm, obj, args) => {
      if (obj.drainModel) {
        obj.drainModel.reset(nowMillis(jvm));
      }
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
      obj.drainModel = null;
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
