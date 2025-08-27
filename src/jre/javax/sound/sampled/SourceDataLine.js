let Speaker;
try {
  Speaker = require("speaker");
} catch (err) {
  // Fallback for environments where speaker package is not available
  console.warn("Speaker package not available, audio output disabled");
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
      if (event === "drain") {
        setTimeout(callback, 0);
      }
    }
  };
}

module.exports = {
  super: "javax/sound/sampled/DataLine",
  methods: {
    "open(Ljavax/sound/sampled/AudioFormat;)V": (jvm, obj, args) => {
      const [format] = args;
      const formatFields = format.fields["javax/sound/sampled/AudioFormat"];

      try {
        const speaker = new Speaker({
          channels: formatFields.channels || 1,
          bitDepth: formatFields.sampleSizeInBits || 16,
          sampleRate: formatFields.sampleRate || 44100,
          signed:
            formatFields.signed !== undefined ? formatFields.signed : true,
        });

        obj.speaker = speaker;
        obj.isOpen = true;
      } catch (error) {
        console.error("Failed to open audio device:", error.message);
        throw {
          type: "javax/sound/sampled/LineUnavailableException",
          message: "Failed to open audio device: " + error.message,
        };
      }
    },
    "open(Ljavax/sound/sampled/AudioFormat;I)V": (jvm, obj, args) => {
      // bufferSize is ignored for now
      const self = jvm.jre["javax/sound/sampled/SourceDataLine"];
      self.methods["open(Ljavax/sound/sampled/AudioFormat;)V"](jvm, obj, args);
    },
    "write([BII)I": (jvm, obj, args) => {
      const [buffer, offset, len] = args;

      if (!obj.speaker || !obj.isOpen) {
        throw {
          type: "java/lang/IllegalStateException",
          message: "Line is not open",
        };
      }

      try {
        const data = Buffer.from(buffer.slice(offset, offset + len));
        obj.speaker.write(data);
        return len;
      } catch (error) {
        console.error("Audio write error:", error.message);
        throw {
          type: "java/io/IOException",
          message: "Audio write failed: " + error.message,
        };
      }
    },
    "available()I": (jvm, obj, args) => {
      // Return a reasonable buffer size estimate
      return 4096;
    },
    "flush()V": (jvm, obj, args) => {
      // Not implemented for speaker - data is sent immediately
    },
    "start()V": (jvm, obj, args) => {
      // Speaker starts automatically on first write
      obj.isStarted = true;
    },
    "stop()V": (jvm, obj, args) => {
      // Not implemented - speaker continues until closed
      obj.isStarted = false;
    },
    "drain()V": async (jvm, obj, args) => {
      if (!obj.speaker) {
        return;
      }

      await new Promise((resolve) => {
        obj.speaker.once("drain", resolve);
      });
    },
    "close()V": (jvm, obj, args) => {
      if (obj.speaker) {
        try {
          obj.speaker.end();
        } catch (error) {
          console.error("Error closing speaker:", error.message);
        }
        obj.speaker = null;
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
