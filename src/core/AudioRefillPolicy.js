'use strict';

// Scheduling hints only. Guest writes, PCM, buffer capacity and Java thread
// blocking semantics are unchanged. A sleeping producer remains registered;
// selecting it is forbidden until the ordinary scheduler wakes it.
class AudioRefillPolicy {
  constructor(now = () => globalThis.performance?.now() ?? Date.now()) {
    this.now = now;
    this.sources = new Map();
  }
  requested(thread, output) {
    if (!thread || !output || typeof output.queuedSeconds !== 'function') return;
    const state = this.sources.get(output) || {output, refillMs: 8};
    if (state.thread !== thread || state.startedAt === undefined) state.startedAt = this.now();
    state.thread = thread;
    this.sources.set(output, state);
  }
  completed(thread, output) {
    if (!thread || !output || typeof output.queuedSeconds !== 'function') return;
    const state = this.sources.get(output) || {output, refillMs: 8};
    if (state.thread === thread && state.startedAt !== undefined) {
      const elapsed = this.now() - state.startedAt;
      if (Number.isFinite(elapsed) && elapsed >= 0)
        state.refillMs = state.refillMs * 0.75 + elapsed * 0.25;
    }
    state.thread = thread;
    state.startedAt = undefined;
    this.sources.set(output, state);
  }
  select(threads) {
    let selected = null, earliest = Infinity;
    for (const [output, state] of this.sources) {
      const thread = state.thread;
      if (output.closed || !threads.includes(thread) || thread.status === 'terminated') {
        this.sources.delete(output);
        continue;
      }
      if (thread.status !== 'runnable' || output.context?.state === 'suspended' ||
          output.context?.state === 'closed') continue;
      const queued = output.queuedSeconds();
      if (!Number.isFinite(queued) || queued < 0) continue;
      const capacity = output.bufferSize / output.bytesPerFrame / output.options?.sampleRate;
      const lead = Math.min(0.12, Number.isFinite(capacity) && capacity > 0 ? capacity / 2 : 0.12,
        Math.max(0.04, state.refillMs * 2 / 1000));
      const slack = queued - state.refillMs / 1000;
      if (queued < lead && slack < earliest) {
        earliest = slack;
        selected = {thread, output, until: Infinity};
      }
    }
    return selected;
  }
}
module.exports = AudioRefillPolicy;
