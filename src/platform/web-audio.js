(function registerWebAudio(global) {
  if (!global || !global.JVMDebug || !global.JVMDebug.audioPlatform) {
    return;
  }

  let sharedAudioContext = null;

  function getAudioContext() {
    const AudioContextCtor = global.AudioContext || global.webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }
    if (!sharedAudioContext || sharedAudioContext.state === "closed") {
      sharedAudioContext = new AudioContextCtor();
    }
    return sharedAudioContext;
  }

  class WebAudioOutput {
    constructor(options) {
      this.options = options;
      this.context = getAudioContext();
      if (!this.context) {
        throw new Error("WebAudio is not available");
      }
      this.pendingSources = 0;
      this.drainCallbacks = [];
      this.scheduledTime = this.context.currentTime;
    }

    write(data) {
      const bytes = toByteArray(data);
      const channels = Math.max(1, this.options.channels || 1);
      const bitDepth = this.options.bitDepth || 16;
      const bytesPerSample = bitDepth / 8;
      if (bytesPerSample !== 1 && bytesPerSample !== 2) {
        throw new Error("Unsupported WebAudio sample size: " + bitDepth);
      }

      const frameCount = Math.floor(bytes.length / (bytesPerSample * channels));
      if (frameCount <= 0) {
        this.flushDrainCallbacks();
        return;
      }

      if (this.context.state === "suspended" && typeof this.context.resume === "function") {
        this.context.resume().catch(function() {});
      }

      const audioBuffer = this.context.createBuffer(
        channels,
        frameCount,
        this.options.sampleRate || this.context.sampleRate || 44100,
      );

      for (let channel = 0; channel < channels; channel += 1) {
        const channelData = audioBuffer.getChannelData(channel);
        for (let frame = 0; frame < frameCount; frame += 1) {
          const sampleIndex = (frame * channels + channel) * bytesPerSample;
          channelData[frame] = decodePcmSample(
            bytes,
            sampleIndex,
            bitDepth,
            this.options.signed !== false,
            this.options.bigEndian === true,
          );
        }
      }

      const source = this.context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.context.destination);
      this.pendingSources += 1;
      source.onended = () => {
        this.pendingSources -= 1;
        if (this.pendingSources === 0) {
          this.flushDrainCallbacks();
        }
      };

      const startTime = Math.max(this.context.currentTime, this.scheduledTime);
      source.start(startTime);
      this.scheduledTime = startTime + audioBuffer.duration;
    }

    once(event, callback) {
      if (event !== "drain") {
        return;
      }
      if (this.pendingSources === 0) {
        setTimeout(callback, 0);
      } else {
        this.drainCallbacks.push(callback);
      }
    }

    flushDrainCallbacks() {
      const callbacks = this.drainCallbacks.splice(0);
      callbacks.forEach((callback) => setTimeout(callback, 0));
    }

    end() {
      this.pendingSources = 0;
      this.flushDrainCallbacks();
    }
  }

  function toByteArray(data) {
    if (data == null) {
      return [];
    }
    if (ArrayBuffer.isView(data)) {
      return Array.from(data);
    }
    return Array.from(data, (value) => value & 0xff);
  }

  function decodePcmSample(bytes, index, bitDepth, signed, bigEndian) {
    if (bitDepth === 8) {
      const byte = bytes[index] & 0xff;
      const sample = signed ? signed8(byte) : byte - 128;
      return clampSample(sample / 128);
    }

    const first = bytes[index] & 0xff;
    const second = bytes[index + 1] & 0xff;
    const raw = bigEndian ? (first << 8) | second : first | (second << 8);
    const sample = signed ? signed16(raw) : raw - 32768;
    return clampSample(sample / 32768);
  }

  function signed8(value) {
    return value > 127 ? value - 256 : value;
  }

  function signed16(value) {
    return value > 32767 ? value - 65536 : value;
  }

  function clampSample(value) {
    return Math.max(-1, Math.min(1, value));
  }

  global.JVMDebug.audioPlatform.setAudioOutputFactory((options) => new WebAudioOutput(options));
})(typeof window !== "undefined" ? window : globalThis);
