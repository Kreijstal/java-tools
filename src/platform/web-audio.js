(function registerWebAudio(global) {
  if (!global || !global.JVMDebug || !global.JVMDebug.audioPlatform) {
    return;
  }

  let sharedAudioContext = null;
  let resumeListenersInstalled = false;
  let outputCount = 0;
  let closedOutputCount = 0;
  let writeCount = 0;
  let writtenFrames = 0;
  let sampledFrames = 0;
  let nonSilentSampledFrames = 0;
  let peakSampledAmplitude = 0;
  const activeOutputs = new Set();

  function resumeSharedAudioContext() {
    const context = getAudioContext();
    if (!context || context.state !== "suspended" ||
        typeof sharedAudioContext.resume !== "function") {
      return;
    }
    context.resume().catch(function() {});
  }

  function installResumeListeners() {
    if (resumeListenersInstalled || !global.document ||
        typeof global.document.addEventListener !== "function") {
      return;
    }
    resumeListenersInstalled = true;
    const resume = () => resumeSharedAudioContext();
    const options = { passive: true, capture: true };
    global.document.addEventListener("pointerdown", resume, options);
    global.document.addEventListener("keydown", resume, options);
    global.document.addEventListener("touchstart", resume, options);
  }

  function getAudioContext() {
    const AudioContextCtor = global.AudioContext || global.webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }
    if (!sharedAudioContext || sharedAudioContext.state === "closed") {
      sharedAudioContext = new AudioContextCtor();
      installResumeListeners();
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
      outputCount += 1;
      this.pendingSources = 0;
      this.sources = new Set();
      this.drainCallbacks = [];
      this.scheduledTime = this.context.currentTime;
      this.bufferSize = Math.max(1, Number(options.bufferSize) || 4096);
      this.bytesPerFrame = Math.max(1, options.channels || 1) *
        Math.max(1, (options.bitDepth || 16) / 8);
      this.closed = false;
      activeOutputs.add(this);
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
      writeCount += 1;
      writtenFrames += frameCount;

      if (this.context.state === "suspended" && typeof this.context.resume === "function") {
        resumeSharedAudioContext();
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
      // Sample the already-decoded signal sparsely. This is diagnostics, not
      // a second full PCM pass through a hot audio loop.
      const diagnosticChannel = audioBuffer.getChannelData(0);
      for (let frame = 0; frame < frameCount; frame += 128) {
        const amplitude = Math.abs(diagnosticChannel[frame]);
        sampledFrames += 1;
        if (amplitude > 1 / 32768) {
          nonSilentSampledFrames += 1;
        }
        if (amplitude > peakSampledAmplitude) {
          peakSampledAmplitude = amplitude;
        }
      }

      const source = this.context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.context.destination);
      this.pendingSources += 1;
      this.sources.add(source);
      source.onended = () => {
        if (!this.sources.delete(source)) {
          return;
        }
        this.pendingSources = Math.max(0, this.pendingSources - 1);
        if (this.pendingSources === 0) {
          this.flushDrainCallbacks();
        }
      };

      const startTime = Math.max(this.context.currentTime, this.scheduledTime);
      source.start(startTime);
      this.scheduledTime = startTime + audioBuffer.duration;
    }

    available() {
      if (this.closed) {
        return this.bufferSize;
      }
      const sampleRate = this.options.sampleRate ||
        this.context.sampleRate ||
        44100;
      const queuedFrames = Math.ceil(
        Math.max(0, this.scheduledTime - this.context.currentTime) * sampleRate,
      );
      return Math.max(0,
        this.bufferSize - queuedFrames * this.bytesPerFrame);
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

    queuedSeconds() {
      return Math.max(0, this.scheduledTime - this.context.currentTime);
    }

    flush() {
      for (const source of this.sources) {
        source.onended = null;
        if (typeof source.stop === "function") {
          try {
            source.stop();
          } catch (error) {
            // A source that ended between iteration and stop is already done.
          }
        }
      }
      this.sources.clear();
      this.pendingSources = 0;
      this.scheduledTime = this.context.currentTime;
      this.flushDrainCallbacks();
    }

    end() {
      if (this.closed) {
        return;
      }
      this.flush();
      this.closed = true;
      activeOutputs.delete(this);
      closedOutputCount += 1;
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

  // Install the unlock path before the game creates SourceDataLine. Dekobloko
  // opens audio only after its login gesture; installing here lets Firefox
  // create and resume the context inside that gesture instead of creating a
  // permanently suspended context several seconds later.
  installResumeListeners();
  global.JVMDebug.audioPlatform.getWebAudioDiagnostics = () => {
    let queuedSeconds = 0;
    let maxOutputQueueSeconds = 0;
    for (const output of activeOutputs) {
      const outputQueueSeconds = output.queuedSeconds();
      queuedSeconds += outputQueueSeconds;
      maxOutputQueueSeconds = Math.max(maxOutputQueueSeconds, outputQueueSeconds);
    }
    return {
      registered: true,
      contextCreated: Boolean(sharedAudioContext),
      contextState: sharedAudioContext ? sharedAudioContext.state : "uncreated",
      outputs: outputCount,
      activeOutputs: activeOutputs.size,
      closedOutputs: closedOutputCount,
      writes: writeCount,
      writtenFrames,
      sampledFrames,
      nonSilentSampledFrames,
      peakSampledAmplitude: Math.round(peakSampledAmplitude * 1000000) / 1000000,
      queuedSeconds: Math.round(queuedSeconds * 1000) / 1000,
      maxOutputQueueSeconds: Math.round(maxOutputQueueSeconds * 1000) / 1000,
    };
  };
  global.JVMDebug.audioPlatform.setAudioOutputFactory((options) => new WebAudioOutput(options));
})(typeof window !== "undefined" ? window : globalThis);
