'use strict';

// JVM-local time and entropy source. Deterministic mode is enabled by
// JVM_FAKE_TIME (or the JVM constructor's fakeTime option). Keeping the state
// on each JVM prevents concurrent instances from perturbing one another.

class RuntimeClock {
  constructor(options = {}) {
    const base = Number(options.fakeTime);
    const step = Number(options.fakeTimeStep);
    this.enabled = options.fakeTime !== undefined && options.fakeTime !== null &&
      String(options.fakeTime) !== '';
    this.ms = this.enabled && Number.isFinite(base) && base > 0 ? base : 1000000000000;
    this.step = this.enabled && Number.isFinite(step) && step > 0 ? step : 1;
    this.seedCounter = 0;
    this.lcg = 0x5DEECE66Dn;
  }

  millis() {
    if (!this.enabled) return Date.now();
    this.ms += this.step;
    return Math.floor(this.ms);
  }

  nanos() {
    if (!this.enabled) {
      if (typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint) {
        return Number(process.hrtime.bigint());
      }
      return Date.now() * 1000000;
    }
    this.ms += this.step;
    return Math.floor(this.ms * 1000000);
  }

  nextSeed() {
    if (!this.enabled) return BigInt(Date.now());
    this.seedCounter += 1;
    return BigInt(this.seedCounter) * 0x9E3779B9n;
  }

  random() {
    if (!this.enabled) return Math.random();
    this.lcg = (this.lcg * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
    return Number(this.lcg >> 21n) / 134217728;
  }

  snapshot() {
    if (!this.enabled) return null;
    return {
      enabled: true,
      ms: this.ms,
      step: this.step,
      seedCounter: this.seedCounter,
      lcg: String(this.lcg),
    };
  }

  restore(snapshot) {
    if (!snapshot || !snapshot.enabled) return;
    this.enabled = true;
    this.ms = Number(snapshot.ms);
    this.step = Number(snapshot.step);
    this.seedCounter = Number(snapshot.seedCounter) || 0;
    this.lcg = BigInt(snapshot.lcg || '25214903917');
  }
}

function createClock(options = {}) {
  return new RuntimeClock(options);
}

module.exports = { RuntimeClock, createClock };
