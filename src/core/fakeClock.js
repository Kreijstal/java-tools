'use strict';

// Deterministic time source for reproducible runs, enabled by setting
// JVM_FAKE_TIME to the starting epoch milliseconds (any non-empty value;
// non-numeric falls back to 1e12). Each query advances the clock so game
// loops that busy-wait on currentTimeMillis() still make progress, while two
// runs of the same workload observe identical timestamps.
//
// JVM_FAKE_TIME_STEP tunes how many milliseconds each query advances
// (default 1, fractions allowed). The interpreter is orders of magnitude
// slower than a real JVM, so with the default step time-budgeted loops (e.g.
// dekobloko's JS5 reader, which processes bytes "while elapsed < N ms" per
// frame) exhaust their budget after N queries having done almost no work,
// and time-based retry watchdogs fire long before slow work completes. A
// small step (e.g. 0.01) stretches every time budget to match the
// interpreter's real speed.

let state = null;
if (typeof process !== 'undefined' && process.env && process.env.JVM_FAKE_TIME) {
  const base = Number(process.env.JVM_FAKE_TIME);
  const step = Number(process.env.JVM_FAKE_TIME_STEP);
  state = {
    ms: Number.isFinite(base) && base > 0 ? base : 1000000000000,
    step: Number.isFinite(step) && step > 0 ? step : 1,
  };
}

module.exports = {
  enabled: !!state,
  millis() {
    state.ms += state.step;
    return Math.floor(state.ms);
  },
  nanos() {
    state.ms += state.step;
    return Math.floor(state.ms * 1000000);
  },
  // Deterministic seed sequence for `new java.util.Random()`.
  _seedCounter: 0,
  nextSeed() {
    this._seedCounter += 1;
    return BigInt(this._seedCounter) * 0x9E3779B9n;
  },
  // Deterministic drop-in for Math.random() (48-bit LCG, same constants
  // as java.util.Random).
  _lcg: 0x5DEECE66Dn,
  random() {
    this._lcg = (this._lcg * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
    return Number(this._lcg >> 21n) / 134217728; // top 27 bits / 2^27
  },
};
