(function registerWebAudio(global) {
  if (!global || !global.JVMDebug || !global.JVMDebug.audioPlatform) {
    return;
  }

  let sharedAudioContext = null;
  let sharedWorkletReady = null;
  let resumeListenersInstalled = false;
  let outputCount = 0;
  let closedOutputCount = 0;
  let writeCount = 0;
  let writtenFrames = 0;
  let sampledFrames = 0;
  let nonSilentSampledFrames = 0;
  let peakSampledAmplitude = 0;
  let underrunCount = 0;
  let underrunSeconds = 0;
  let scheduledBufferCount = 0;
  let coalescedWriteCount = 0;
  let boundaryJumpCount = 0;
  let boundaryJumpTotal = 0;
  let boundaryJumpMaximum = 0;
  let saturatedSampleCount = 0;
  const activeOutputs = new Set();
  const forceMonoByQuery = Boolean(global.location &&
    typeof global.location.search === "string" &&
    new URLSearchParams(global.location.search).get("audio") === "mono");
  const WORKLET_SOURCE = `
class JVMSourceDataLineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.channels = Math.max(1, config.channels || 1);
    this.inputRate = Math.max(1, config.sampleRate || sampleRate);
    this.ratio = this.inputRate / sampleRate;
    this.startFrames = Math.max(1, config.startFrames || 2048);
    this.chunks = [];
    this.chunkOffset = 0;
    this.queuedFrames = 0;
    this.phase = 0;
    this.current = null;
    this.next = null;
    this.started = false;
    this.generation = 0;
    this.reportCountdown = 0;
    this.port.onmessage = event => {
      const message = event.data || {};
      if (message.type === "pcm" && message.generation === this.generation) {
        this.chunks.push(new Float32Array(message.samples));
        this.queuedFrames += message.frames || 0;
      } else if (message.type === "flush") {
        this.generation = message.generation;
        this.chunks.length = 0;
        this.chunkOffset = 0;
        this.queuedFrames = 0;
        this.current = this.next = null;
        this.started = false;
        this.phase = 0;
      }
    };
  }
  readFrame() {
    while (this.chunks.length) {
      const chunk = this.chunks[0];
      if (this.chunkOffset + this.channels <= chunk.length) {
        const frame = new Float32Array(this.channels);
        for (let channel = 0; channel < this.channels; channel++)
          frame[channel] = chunk[this.chunkOffset + channel];
        this.chunkOffset += this.channels;
        this.queuedFrames = Math.max(0, this.queuedFrames - 1);
        if (this.chunkOffset >= chunk.length) {
          this.chunks.shift();
          this.chunkOffset = 0;
        }
        return frame;
      }
      this.chunks.shift();
      this.chunkOffset = 0;
    }
    return null;
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (!this.started && this.queuedFrames >= this.startFrames) {
      this.current = this.readFrame();
      this.next = this.readFrame();
      this.started = Boolean(this.current && this.next);
    }
    for (let frame = 0; frame < output[0].length; frame++) {
      if (!this.started || !this.current || !this.next) break;
      for (let channel = 0; channel < output.length; channel++) {
        const sourceChannel = Math.min(channel, this.channels - 1);
        output[channel][frame] = this.current[sourceChannel] +
          (this.next[sourceChannel] - this.current[sourceChannel]) * this.phase;
      }
      this.phase += this.ratio;
      while (this.phase >= 1) {
        this.phase -= 1;
        this.current = this.next;
        this.next = this.readFrame();
        if (!this.next) {
          this.port.postMessage({type: "underrun"});
          this.started = false;
          this.current = null;
          break;
        }
      }
    }
    if (--this.reportCountdown <= 0) {
      this.reportCountdown = 16;
      this.port.postMessage({type: "queue", frames: this.queuedFrames});
    }
    return true;
  }
}
registerProcessor("jvm-source-data-line", JVMSourceDataLineProcessor);`;

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
      if (sharedAudioContext.audioWorklet && global.AudioWorkletNode &&
          global.Blob && global.URL &&
          typeof global.URL.createObjectURL === "function") {
        const url = global.URL.createObjectURL(new global.Blob(
          [WORKLET_SOURCE], { type: "text/javascript" }));
        sharedWorkletReady = sharedAudioContext.audioWorklet.addModule(url)
          .finally(() => global.URL.revokeObjectURL(url));
      }
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
      // SourceDataLine is a continuous stream. Scheduling every 256-frame
      // guest write as an independent 22.05 kHz AudioBufferSource makes the
      // browser restart its sample-rate converter at every tiny boundary.
      // Preserve larger continuous regions before handing them to WebAudio.
      const capacityFrames = Math.max(1,
        Math.floor(this.bufferSize / this.bytesPerFrame));
      this.coalesceFrames = Math.max(1,
        Number(options.coalesceFrames) ||
        Math.min(2048, Math.max(256, Math.floor(capacityFrames / 4))));
      this.coalesceDelayMs = Math.max(0,
        Number.isFinite(Number(options.coalesceDelayMs))
          ? Number(options.coalesceDelayMs)
          : 100);
      this.stagedChunks = [];
      this.stagedByteLength = 0;
      this.stagedFrames = 0;
      this.stageTimer = null;
      this.lastSamples = new Array(Math.max(1, options.channels || 1)).fill(null);
      this.channelAbsoluteSums =
        new Array(Math.max(1, options.channels || 1)).fill(0);
      this.channelDifferenceSums =
        new Array(Math.max(1, options.channels || 1)).fill(0);
      this.channelPcmChecksums =
        new Array(Math.max(1, options.channels || 1)).fill(0);
      this.channelContentPcmChecksums =
        new Array(Math.max(1, options.channels || 1)).fill(0);
      this.pcmChecksum = 0;
      this.contentPcmChecksum = 0;
      this.pcmRecordedFrames = 0;
      this.contentFrames = 0;
      this.firstNonSilentFrame = null;
      this.decodedFrames = 0;
      this.underruns = 0;
      this.underrunSeconds = 0;
      this.forceMono = options.forceMono === true || forceMonoByQuery;
      this.workletNode = null;
      this.workletQueuedFrames = 0;
      this.workletGeneration = 0;
      // Long-lived music benefits from an ~80 ms cushion, but short-lived
      // effect lines often contain only one coalesced region. Requiring the
      // music-sized cushion there means valid transient PCM is queued but the
      // processor never starts. Keep the threshold no larger than the first
      // region the line naturally publishes (and at least two frames for the
      // linear interpolator).
      this.workletStartFrames = Math.max(2, Math.min(
        this.coalesceFrames,
        Math.round((this.options.sampleRate || 44100) * 0.08),
      ));
      if (sharedWorkletReady) {
        sharedWorkletReady.then(() => {
          if (this.closed) return;
          const playbackChannels =
            this.forceMono && (this.options.channels || 1) > 1
              ? 1 : Math.max(1, this.options.channels || 1);
          this.workletNode = new global.AudioWorkletNode(
            this.context, "jvm-source-data-line", {
              numberOfInputs: 0,
              numberOfOutputs: 1,
              outputChannelCount: [playbackChannels],
              processorOptions: {
                channels: playbackChannels,
                sampleRate: this.options.sampleRate,
                startFrames: this.workletStartFrames,
              },
            });
          this.workletNode.port.onmessage = event => {
            if (event.data && event.data.type === "queue") {
              this.workletQueuedFrames = Math.max(0,
                Number(event.data.frames) || 0);
              this.maybeFlushDrainCallbacks();
            } else if (event.data && event.data.type === "underrun") {
              this.underruns += 1;
              underrunCount += 1;
            }
          };
          this.workletNode.connect(this.context.destination);
          this.scheduleStaged();
        }).catch(() => {
          sharedWorkletReady = null;
          this.scheduleStaged();
        });
      }
      this.guestWrites = 0;
      this.scheduledBuffers = 0;
      this.closed = false;
      this.hasScheduledAudio = false;
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
      this.guestWrites += 1;

      if (this.context.state === "suspended" && typeof this.context.resume === "function") {
        resumeSharedAudioContext();
      }
      // Staging outlives the guest write call, whose backing byte array may
      // be reused immediately for the next mixer region.
      this.stagedChunks.push(new Uint8Array(bytes));
      this.stagedByteLength += bytes.length;
      this.stagedFrames += frameCount;
      if (this.stagedFrames >= this.coalesceFrames) {
        this.scheduleStaged();
      } else if (this.stageTimer === null && this.coalesceDelayMs > 0) {
        this.stageTimer = setTimeout(() => {
          this.stageTimer = null;
          if (!this.closed) this.scheduleStaged();
        }, this.coalesceDelayMs);
      }
    }

    scheduleStaged() {
      if (this.stageTimer !== null) {
        clearTimeout(this.stageTimer);
        this.stageTimer = null;
      }
      if (this.stagedByteLength <= 0) {
        return;
      }
      if (sharedWorkletReady && !this.workletNode) return;
      const bytes = new Uint8Array(this.stagedByteLength);
      let byteOffset = 0;
      for (const chunk of this.stagedChunks) {
        bytes.set(chunk, byteOffset);
        byteOffset += chunk.length;
      }
      const representedWrites = this.stagedChunks.length;
      this.stagedChunks = [];
      this.stagedByteLength = 0;
      this.stagedFrames = 0;
      if (representedWrites > 1) {
        coalescedWriteCount += representedWrites - 1;
      }
      this.recordPcmBytes(bytes);
      if (this.workletNode) this.scheduleWorkletBytes(bytes);
      else this.scheduleBytes(bytes);
    }

    recordPcmBytes(bytes) {
      const channels = Math.max(1, this.options.channels || 1);
      const bitDepth = this.options.bitDepth || 16;
      const bytesPerSample = (this.options.bitDepth || 16) / 8;
      const frameCount =
        Math.floor(bytes.length / (channels * bytesPerSample));
      for (let frame = 0; frame < frameCount; frame += 1) {
        let hasSignal = false;
        for (let channel = 0; channel < channels; channel += 1) {
          const sampleIndex =
            (frame * channels + channel) * bytesPerSample;
          if (bitDepth === 8) {
            const silence = this.options.signed !== false ? 0 : 128;
            hasSignal ||= (bytes[sampleIndex] & 0xff) !== silence;
          } else {
            const first = bytes[sampleIndex] & 0xff;
            const second = bytes[sampleIndex + 1] & 0xff;
            const raw = this.options.bigEndian === true
              ? (first << 8) | second : first | (second << 8);
            const silence = this.options.signed !== false ? 0 : 32768;
            hasSignal ||= raw !== silence;
          }
        }
        if (this.firstNonSilentFrame === null && hasSignal) {
          this.firstNonSilentFrame = this.pcmRecordedFrames + frame;
        }
        const contentStarted = this.firstNonSilentFrame !== null;
        for (let channel = 0; channel < channels; channel += 1) {
          const sampleIndex =
            (frame * channels + channel) * bytesPerSample;
          for (let byte = 0; byte < bytesPerSample; byte += 1) {
            const signedByte = signed8(bytes[sampleIndex + byte] & 0xff);
            this.pcmChecksum =
              (Math.imul(this.pcmChecksum, 31) + signedByte) | 0;
            this.channelPcmChecksums[channel] = (
              Math.imul(this.channelPcmChecksums[channel], 31) + signedByte
            ) | 0;
            if (contentStarted) {
              this.contentPcmChecksum = (
                Math.imul(this.contentPcmChecksum, 31) + signedByte
              ) | 0;
              this.channelContentPcmChecksums[channel] = (
                Math.imul(this.channelContentPcmChecksums[channel], 31) +
                signedByte
              ) | 0;
            }
          }
        }
        if (contentStarted) this.contentFrames += 1;
      }
      this.pcmRecordedFrames += frameCount;
    }

    scheduleWorkletBytes(bytes) {
      const channels = Math.max(1, this.options.channels || 1);
      const bitDepth = this.options.bitDepth || 16;
      const bytesPerSample = bitDepth / 8;
      const frames = Math.floor(bytes.length / (channels * bytesPerSample));
      const playbackChannels = this.forceMono && channels > 1 ? 1 : channels;
      const samples = new Float32Array(frames * playbackChannels);
      for (let frame = 0; frame < frames; frame++) {
        if (playbackChannels === 1 && channels > 1) {
          let sum = 0;
          for (let channel = 0; channel < channels; channel++) {
            const sampleIndex =
              (frame * channels + channel) * bytesPerSample;
            const sample = decodePcmSample(bytes,
              sampleIndex, bitDepth,
              this.options.signed !== false, this.options.bigEndian === true);
            sum += sample;
            const amplitude = Math.abs(sample);
            if (amplitude >= 1) saturatedSampleCount += 1;
            this.channelAbsoluteSums[channel] += amplitude;
            if (frame === 0 && this.lastSamples[channel] !== null) {
              const jump = Math.abs(sample - this.lastSamples[channel]);
              boundaryJumpCount += 1;
              boundaryJumpTotal += jump;
              boundaryJumpMaximum = Math.max(boundaryJumpMaximum, jump);
            }
            if (this.lastSamples[channel] !== null) {
              this.channelDifferenceSums[channel] +=
                Math.abs(sample - this.lastSamples[channel]);
            }
            this.lastSamples[channel] = sample;
          }
          samples[frame] = sum / channels;
        } else {
          for (let channel = 0; channel < channels; channel++) {
            const sampleIndex =
              (frame * channels + channel) * bytesPerSample;
            const sample = decodePcmSample(bytes,
              sampleIndex, bitDepth,
              this.options.signed !== false, this.options.bigEndian === true);
            samples[frame * channels + channel] = sample;
            const amplitude = Math.abs(sample);
            if (amplitude >= 1) saturatedSampleCount += 1;
            this.channelAbsoluteSums[channel] += amplitude;
            if (frame === 0 && this.lastSamples[channel] !== null) {
              const jump = Math.abs(sample - this.lastSamples[channel]);
              boundaryJumpCount += 1;
              boundaryJumpTotal += jump;
              boundaryJumpMaximum = Math.max(boundaryJumpMaximum, jump);
            }
            if (this.lastSamples[channel] !== null) {
              this.channelDifferenceSums[channel] +=
                Math.abs(sample - this.lastSamples[channel]);
            }
            this.lastSamples[channel] = sample;
          }
        }
        if (frame % 128 === 0) {
          const diagnosticSample = samples[frame * playbackChannels];
          const amplitude = Math.abs(diagnosticSample);
          sampledFrames += 1;
          if (amplitude > 1 / 32768) nonSilentSampledFrames += 1;
          if (amplitude > peakSampledAmplitude) {
            peakSampledAmplitude = amplitude;
          }
        }
      }
      this.decodedFrames += frames;
      this.workletQueuedFrames += frames;
      this.workletNode.port.postMessage({
        type: "pcm", generation: this.workletGeneration, frames,
        samples: samples.buffer,
      }, [samples.buffer]);
    }

    scheduleBytes(bytes) {
      const channels = Math.max(1, this.options.channels || 1);
      const bitDepth = this.options.bitDepth || 16;
      const bytesPerSample = bitDepth / 8;
      const frameCount = Math.floor(bytes.length / (bytesPerSample * channels));
      if (frameCount <= 0) return;
      const playbackChannels = this.forceMono && channels > 1 ? 1 : channels;
      const audioBuffer = this.context.createBuffer(
        playbackChannels,
        frameCount,
        this.options.sampleRate || this.context.sampleRate || 44100,
      );

      const decodedChannels = new Array(channels);
      for (let channel = 0; channel < channels; channel += 1) {
        const channelData = playbackChannels === channels
          ? audioBuffer.getChannelData(channel)
          : new Float32Array(frameCount);
        decodedChannels[channel] = channelData;
        for (let frame = 0; frame < frameCount; frame += 1) {
          const sampleIndex = (frame * channels + channel) * bytesPerSample;
          channelData[frame] = decodePcmSample(
            bytes,
            sampleIndex,
            bitDepth,
            this.options.signed !== false,
            this.options.bigEndian === true,
          );
          const amplitude = Math.abs(channelData[frame]);
          if (amplitude >= 1) saturatedSampleCount += 1;
          this.channelAbsoluteSums[channel] += amplitude;
          if (frame === 0 && this.lastSamples[channel] !== null) {
            const jump = Math.abs(channelData[frame] - this.lastSamples[channel]);
            boundaryJumpCount += 1;
            boundaryJumpTotal += jump;
            boundaryJumpMaximum = Math.max(boundaryJumpMaximum, jump);
          }
          if (this.lastSamples[channel] !== null) {
            this.channelDifferenceSums[channel] +=
              Math.abs(channelData[frame] - this.lastSamples[channel]);
          }
          this.lastSamples[channel] = channelData[frame];
        }
      }
      if (playbackChannels === 1 && channels > 1) {
        const mono = audioBuffer.getChannelData(0);
        for (let frame = 0; frame < frameCount; frame += 1) {
          let value = 0;
          for (let channel = 0; channel < channels; channel += 1) {
            value += decodedChannels[channel][frame];
          }
          mono[frame] = value / channels;
        }
      }
      this.decodedFrames += frameCount;
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
      this.scheduledBuffers += 1;
      scheduledBufferCount += 1;
      source.onended = () => {
        if (!this.sources.delete(source)) {
          return;
        }
        this.pendingSources = Math.max(0, this.pendingSources - 1);
        if (this.pendingSources === 0) {
          this.flushDrainCallbacks();
        }
      };

      const now = this.context.currentTime;
      if (this.hasScheduledAudio && this.scheduledTime < now) {
        const gap = now - this.scheduledTime;
        underrunCount += 1;
        underrunSeconds += gap;
        this.underruns += 1;
        this.underrunSeconds += gap;
      }
      const startTime = Math.max(now, this.scheduledTime);
      source.start(startTime);
      this.scheduledTime = startTime + audioBuffer.duration;
      this.hasScheduledAudio = true;
    }

    available() {
      if (this.closed) {
        return this.bufferSize;
      }
      const sampleRate = this.options.sampleRate ||
        this.context.sampleRate ||
        44100;
      const queuedFrames = this.workletNode
        ? this.workletQueuedFrames + this.stagedFrames
        : Math.ceil(
          Math.max(0, this.scheduledTime - this.context.currentTime) * sampleRate,
        ) + this.stagedFrames;
      return Math.max(0,
        this.bufferSize - queuedFrames * this.bytesPerFrame);
    }

    once(event, callback) {
      if (event !== "drain") {
        return;
      }
      this.scheduleStaged();
      this.drainCallbacks.push(callback);
      this.maybeFlushDrainCallbacks();
    }

    maybeFlushDrainCallbacks() {
      const drained = this.workletNode
        ? this.stagedFrames === 0 && this.workletQueuedFrames === 0
        : this.pendingSources === 0;
      if (drained) this.flushDrainCallbacks();
    }

    flushDrainCallbacks() {
      const callbacks = this.drainCallbacks.splice(0);
      callbacks.forEach((callback) => setTimeout(callback, 0));
    }

    queuedSeconds() {
      const sampleRate = this.options.sampleRate ||
        this.context.sampleRate ||
        44100;
      if (this.workletNode) {
        return (this.workletQueuedFrames + this.stagedFrames) / sampleRate;
      }
      return Math.max(0, this.scheduledTime - this.context.currentTime) +
        this.stagedFrames / sampleRate;
    }

    flush() {
      if (this.stageTimer !== null) {
        clearTimeout(this.stageTimer);
        this.stageTimer = null;
      }
      this.stagedChunks = [];
      this.stagedByteLength = 0;
      this.stagedFrames = 0;
      if (this.workletNode) {
        this.workletGeneration += 1;
        this.workletQueuedFrames = 0;
        this.workletNode.port.postMessage({
          type: "flush", generation: this.workletGeneration,
        });
      }
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
      if (this.workletNode && typeof this.workletNode.disconnect === "function") {
        this.workletNode.disconnect();
      }
      this.closed = true;
      activeOutputs.delete(this);
      closedOutputCount += 1;
    }
  }

  function toByteArray(data) {
    if (data == null) {
      return new Uint8Array(0);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return Uint8Array.from(data, (value) => value & 0xff);
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

  // Install the unlock path before the game creates SourceDataLine. reference workload
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
      underruns: underrunCount,
      underrunSeconds: Math.round(underrunSeconds * 1000) / 1000,
      scheduledBuffers: scheduledBufferCount,
      coalescedWrites: coalescedWriteCount,
      boundaryJumps: boundaryJumpCount,
      averageBoundaryJump: boundaryJumpCount
        ? Math.round(boundaryJumpTotal / boundaryJumpCount * 1000000) / 1000000
        : 0,
      maximumBoundaryJump:
        Math.round(boundaryJumpMaximum * 1000000) / 1000000,
      saturatedSamples: saturatedSampleCount,
      queuedSeconds: Math.round(queuedSeconds * 1000) / 1000,
      maxOutputQueueSeconds: Math.round(maxOutputQueueSeconds * 1000) / 1000,
      outputFormats: [...activeOutputs].map((output) => ({
        sampleRate: output.options.sampleRate,
        channels: output.options.channels,
        bitDepth: output.options.bitDepth,
        signed: output.options.signed,
        bigEndian: output.options.bigEndian,
        bufferSize: output.bufferSize,
        playbackChannels:
          output.forceMono && output.options.channels > 1
            ? 1
            : output.options.channels,
        forceMono: output.forceMono,
        backend: output.workletNode ? "audio-worklet" : "buffer-sources",
        coalesceFrames: output.coalesceFrames,
        coalesceDelayMs: output.coalesceDelayMs,
        workletStartFrames: output.workletStartFrames,
        guestWrites: output.guestWrites,
        scheduledBuffers: output.scheduledBuffers,
        stagedFrames: output.stagedFrames,
        queuedSeconds:
          Math.round(output.queuedSeconds() * 1000) / 1000,
        underruns: output.underruns,
        underrunSeconds:
          Math.round(output.underrunSeconds * 1000) / 1000,
        decodedFrames: output.decodedFrames,
        pcmChecksum: output.pcmChecksum >>> 0,
        channelPcmChecksums:
          output.channelPcmChecksums.map((checksum) => checksum >>> 0),
        firstNonSilentFrame: output.firstNonSilentFrame,
        contentFrames: output.contentFrames,
        contentPcmChecksum: output.contentPcmChecksum >>> 0,
        channelContentPcmChecksums:
          output.channelContentPcmChecksums.map(
            (checksum) => checksum >>> 0),
        channelAverageAmplitude: output.channelAbsoluteSums.map((sum) =>
          output.decodedFrames
            ? Math.round(sum / output.decodedFrames * 1000000) / 1000000
            : 0),
        channelAverageDifference: output.channelDifferenceSums.map((sum) =>
          output.decodedFrames
            ? Math.round(sum / output.decodedFrames * 1000000) / 1000000
            : 0),
      })),
    };
  };
  global.JVMDebug.audioPlatform.setAudioOutputFactory((options) => new WebAudioOutput(options));
})(typeof window !== "undefined" ? window : globalThis);
