const test = require("tape");

test("WebAudio unlocks before a delayed SourceDataLine open", async (t) => {
  const listeners = new Map();
  const document = {
    addEventListener(type, listener, options) {
      listeners.set(type, { listener, options });
    },
  };
  let factory = null;
  let contextCreations = 0;
  let resumeCalls = 0;
  let stopCalls = 0;
  let lastContext = null;
  const createdBuffers = [];
  class FakeAudioContext {
    constructor() {
      contextCreations += 1;
      this.state = "suspended";
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.destination = {};
      lastContext = this;
    }

    resume() {
      resumeCalls += 1;
      this.state = "running";
      return Promise.resolve();
    }

    createBuffer(channels, frames, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      const buffer = {
        channels,
        data,
        duration: frames / sampleRate,
        getChannelData(channel) { return data[channel]; },
      };
      createdBuffers.push(buffer);
      return buffer;
    }

    createBufferSource() {
      return {
        connect() {},
        start() {},
        stop() { stopCalls += 1; },
      };
    }
  }
  const audioPlatform = {
    setAudioOutputFactory(value) { factory = value; },
  };
  const fakeWindow = {
    document,
    AudioContext: FakeAudioContext,
    JVMDebug: { audioPlatform },
  };
  const modulePath = require.resolve("../src/platform/web-audio");
  const previousWindow = global.window;
  global.window = fakeWindow;
  delete require.cache[modulePath];
  t.teardown(() => {
    delete require.cache[modulePath];
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });

  require(modulePath);

  t.ok(listeners.has("pointerdown"),
    "the gesture listener exists before SourceDataLine creates an output");
  t.equal(contextCreations, 0, "module registration does not create audio eagerly");
  t.ok(listeners.get("pointerdown").options.capture,
    "the unlock observes the gesture before canvas handlers");
  listeners.get("pointerdown").listener();
  await Promise.resolve();
  t.equal(contextCreations, 1, "the user gesture creates the shared context");
  t.equal(resumeCalls, 1, "the same gesture resumes Firefox audio");

  const output = factory({
    channels: 1,
    bitDepth: 16,
    sampleRate: 22050,
    signed: true,
    bigEndian: false,
    coalesceFrames: 1,
    coalesceDelayMs: 0,
  });
  output.write(new Uint8Array([0, 0, 255, 127]));
  const diagnostics = audioPlatform.getWebAudioDiagnostics();
  t.equal(contextCreations, 1, "the delayed line reuses the unlocked context");
  t.equal(diagnostics.contextState, "running", "diagnostics expose audible state");
  t.equal(diagnostics.outputs, 1, "the opened browser output is counted");
  t.equal(diagnostics.activeOutputs, 1, "the live browser output is counted");
  t.equal(diagnostics.writes, 1, "PCM writes are counted");
  t.equal(diagnostics.writtenFrames, 2, "queued PCM frames are counted");
  t.equal(diagnostics.sampledFrames, 1, "signal diagnostics sample sparsely");
  t.equal(diagnostics.nonSilentSampledFrames, 0,
    "a silent sampled frame is distinguished from audible PCM");
  t.equal(diagnostics.peakSampledAmplitude, 0,
    "the sampled peak exposes silence");
  t.equal(diagnostics.underruns, 0,
    "the first PCM write does not count as an underrun");
  t.equal(output.available(), 4092,
    "available reports negotiated free bytes after queued PCM");
  lastContext.currentTime = 0.1;
  output.write(new Uint8Array([0, 0, 0, 0]));
  const starvedDiagnostics = audioPlatform.getWebAudioDiagnostics();
  t.equal(starvedDiagnostics.underruns, 1,
    "a write arriving after the scheduled queue expired counts as an underrun");
  t.ok(starvedDiagnostics.underrunSeconds > 0,
    "diagnostics include the duration of the audio gap");
  output.end();
  const closedDiagnostics = audioPlatform.getWebAudioDiagnostics();
  t.equal(stopCalls, 2, "closing an output cancels queued browser audio");
  t.equal(closedDiagnostics.activeOutputs, 0,
    "closed outputs no longer contribute to queue diagnostics");
  t.equal(closedDiagnostics.closedOutputs, 1, "closed outputs are counted");

  const coalesced = factory({
    channels: 1,
    bitDepth: 16,
    sampleRate: 22050,
    signed: true,
    bigEndian: false,
    coalesceFrames: 4,
    coalesceDelayMs: 0,
  });
  const buffersBefore = closedDiagnostics.scheduledBuffers;
  const reusablePcm = new Uint8Array([0, 0, 1, 0]);
  coalesced.write(reusablePcm);
  reusablePcm.fill(127);
  t.equal(audioPlatform.getWebAudioDiagnostics().scheduledBuffers, buffersBefore,
    "a partial continuous region remains staged");
  t.equal(coalesced.available(), 4092,
    "staged PCM consumes SourceDataLine capacity before scheduling");
  coalesced.write(new Uint8Array([2, 0, 3, 0]));
  const coalescedDiagnostics = audioPlatform.getWebAudioDiagnostics();
  t.equal(coalescedDiagnostics.scheduledBuffers, buffersBefore + 1,
    "adjacent guest writes become one WebAudio source");
  t.equal(coalescedDiagnostics.coalescedWrites, 1,
    "diagnostics report the removed resampler boundary");
  t.deepEqual(coalescedDiagnostics.outputFormats[0], {
    sampleRate: 22050,
    channels: 1,
    bitDepth: 16,
    signed: true,
    bigEndian: false,
    bufferSize: 4096,
    playbackChannels: 1,
    forceMono: false,
    backend: "buffer-sources",
    coalesceFrames: 4,
    coalesceDelayMs: 0,
    workletStartFrames: 4,
    guestWrites: 2,
    scheduledBuffers: 1,
    stagedFrames: 0,
    queuedSeconds: 0,
    underruns: 0,
    underrunSeconds: 0,
    decodedFrames: 4,
    pcmChecksum: 28688826,
    channelPcmChecksums: [28688826],
    firstNonSilentFrame: 1,
    contentFrames: 3,
    contentPcmChecksum: 28688826,
    channelContentPcmChecksums: [28688826],
    channelAverageAmplitude: [0.000046],
    channelAverageDifference: [0.000023],
  }, "diagnostics expose the exact browser PCM contract");
  coalesced.end();

  const downmixed = factory({
    channels: 2,
    bitDepth: 16,
    sampleRate: 22050,
    signed: true,
    bigEndian: false,
    coalesceFrames: 1,
    coalesceDelayMs: 0,
    forceMono: true,
  });
  downmixed.write(new Uint8Array([255, 127, 0, 128]));
  const downmixDiagnostics = audioPlatform.getWebAudioDiagnostics();
  const downmixFormat = downmixDiagnostics.outputFormats[0];
  t.equal(downmixFormat.channels, 2,
    "downmix diagnostics retain the guest stereo input contract");
  t.equal(downmixFormat.playbackChannels, 1,
    "the explicit diagnostic mode publishes mono playback");
  t.equal(createdBuffers[createdBuffers.length - 1].channels, 1,
    "stereo PCM is scheduled in a mono WebAudio buffer");
  t.ok(Math.abs(createdBuffers[createdBuffers.length - 1].data[0][0]) <
    1 / 32768,
  "mono playback averages the left and right samples");
  downmixed.end();

  const timed = factory({
    channels: 1,
    bitDepth: 16,
    sampleRate: 22050,
    signed: true,
    bigEndian: false,
    coalesceFrames: 4,
    coalesceDelayMs: 1,
  });
  const timedBuffersBefore =
    audioPlatform.getWebAudioDiagnostics().scheduledBuffers;
  timed.write(new Uint8Array([4, 0, 5, 0]));
  await new Promise(resolve => setTimeout(resolve, 5));
  t.equal(audioPlatform.getWebAudioDiagnostics().scheduledBuffers,
    timedBuffersBefore + 1,
    "a short effect flushes even when it never fills a complete region");
  timed.end();
  t.end();
});

test("WebAudio starts short effect lines after their first region", async (t) => {
  const listeners = new Map();
  let factory = null;
  let workletOptions = null;
  let workletNode = null;
  const posted = [];
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.destination = {};
      this.audioWorklet = { addModule: () => Promise.resolve() };
    }
    resume() { return Promise.resolve(); }
  }
  class FakeAudioWorkletNode {
    constructor(_context, _name, options) {
      workletOptions = options;
      workletNode = this;
      this.port = {
        onmessage: null,
        postMessage(message) { posted.push(message); },
      };
    }
    connect() {}
    disconnect() {}
  }
  const audioPlatform = {
    setAudioOutputFactory(value) { factory = value; },
  };
  const fakeWindow = {
    document: {
      addEventListener(type, listener) { listeners.set(type, listener); },
    },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    Blob: class FakeBlob {},
    URL: {
      createObjectURL() { return "blob:worklet"; },
      revokeObjectURL() {},
    },
    JVMDebug: { audioPlatform },
  };
  const modulePath = require.resolve("../src/platform/web-audio");
  const previousWindow = global.window;
  global.window = fakeWindow;
  delete require.cache[modulePath];
  t.teardown(() => {
    delete require.cache[modulePath];
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });

  require(modulePath);
  listeners.get("pointerdown")();
  const output = factory({
    channels: 2,
    bitDepth: 16,
    sampleRate: 22050,
    signed: true,
    bigEndian: false,
    bufferSize: 8192,
    coalesceDelayMs: 0,
  });
  await new Promise(resolve => setImmediate(resolve));
  t.equal(workletOptions.processorOptions.startFrames, 512,
    "the 8 KiB effect line uses its first 512-frame region, not 80 ms");
  output.write(new Uint8Array(512 * 2 * 2));
  const pcm = posted.find(message => message.type === "pcm");
  t.equal(pcm && pcm.frames, 512,
    "the first published effect region satisfies the worklet threshold");
  t.equal(audioPlatform.getWebAudioDiagnostics().outputFormats[0]
    .workletStartFrames, 512,
  "telemetry exposes the per-line startup threshold");
  let drained = false;
  output.once("drain", () => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  t.equal(drained, false,
    "worklet drain waits while published PCM remains queued");
  workletNode.port.onmessage({ data: { type: "queue", frames: 0 } });
  await new Promise(resolve => setTimeout(resolve, 0));
  t.equal(drained, true,
    "worklet drain completes after the processor reports an empty queue");
  output.write(new Uint8Array(512 * 2 * 2));
  output.flush();
  const flush = posted.find(message => message.type === "flush");
  t.deepEqual(flush, { type: "flush", generation: 1 },
    "flush advances the worklet generation");
  t.equal(output.queuedSeconds(), 0,
    "flush clears the main-thread worklet queue accounting");
  output.end();
  t.end();
});
