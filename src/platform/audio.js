const disableNativeAudio =
  typeof process !== 'undefined' &&
  process.env &&
  (process.env.JVM_DISABLE_AUDIO === '1' ||
    process.env.JVM_DISABLE_AUDIO === 'true');

let audioOutputFactory = null;

function setAudioOutputFactory(factory) {
  if (factory !== null && typeof factory !== 'function') {
    throw new Error('setAudioOutputFactory requires a function or null');
  }
  audioOutputFactory = factory;
}

function createAudioOutput(options) {
  if (audioOutputFactory) {
    return audioOutputFactory(options);
  }

  const speaker = createNodeSpeakerOutput(options);
  if (speaker) {
    return speaker;
  }

  return new MockAudioOutput(options);
}

function createNodeSpeakerOutput(options) {
  if (disableNativeAudio || typeof window !== 'undefined') {
    return null;
  }

  try {
    // Optional native backend. Browser builds alias this module away.
    const Speaker = require('speaker');
    return new Speaker(options);
  } catch (_) {
    return null;
  }
}

class MockAudioOutput {
  constructor(options) {
    this.options = options;
  }

  write(_data) {}

  end() {}

  once(event, callback) {
    if (event === 'drain') {
      setTimeout(callback, 0);
    }
  }
}

module.exports = {
  MockAudioOutput,
  createAudioOutput,
  setAudioOutputFactory,
};
