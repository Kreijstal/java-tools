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
      return {
        duration: frames / sampleRate,
        getChannelData(channel) { return data[channel]; },
      };
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
  t.end();
});
