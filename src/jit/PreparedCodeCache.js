'use strict';

// Optional, trusted compiler-output storage for pre-main preparation only.
// The embedder owns storage and immutable artifact/configuration identities.
// One method is read, installed or compiled, written, and released at a time.
class PreparedCodeCache {
  constructor(jit, options) {
    this.jit = jit;
    this.store = options.store;
    this.identity = ['runtime', 'source', 'patch', 'configuration'].map(key => {
      const value = options.identity?.[key];
      if (typeof value !== 'string' || !value) throw new TypeError(`prepared cache identity needs ${key}`);
      return value;
    });
    if (typeof this.store?.get !== 'function' || typeof this.store?.put !== 'function') {
      throw new TypeError('prepared cache store needs async get and put');
    }
    this.limit = options.maxEntryBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.limit) || this.limit < 0) throw new RangeError('invalid prepared cache entry budget');
    this.limit = Math.min(this.limit, jit.installedSourceRetention.limit);
    this.enabled = true;
    this.replay = true;
    this.busy = false;
    this.stats = {hits:0, misses:0, writes:0, refused:0, errors:0, peakPayloadBytes:0};
  }

  eligible() {
    return this.jit.effectfulPreparationActive && !this.jit.mainStarted &&
      !this.jit.jvm.guestStarted && !this.jit.hotCallGraphRegions.enabled;
  }

  refuse(reason) {
    this.stats.refused++;
    this.stats.lastRefusal = reason;
    // A changed prefix may invalidate later numbered references. Continue
    // ordinary compilation and refresh storage, but do not resume replay.
    this.replay = false;
  }

  availableBytes() {
    return Math.max(0, Math.min(this.limit,
      this.jit.installedSourceRetention.limit - this.jit.installedSourceRetention.bytes));
  }

  validate(entry, methodKey, before, bytes) {
    if (entry?.version !== 1 || JSON.stringify(entry.identity) !== JSON.stringify(this.identity) ||
        entry.method !== methodKey) return 'cache identity differs';
    let slots = 0;
    const carried = new Set(this.jit.constructor.transportableSiteTables);
    for (const key of Object.keys(before)) {
      if (entry.before?.[key] !== before[key]) return 'site-table prefix differs';
      const end = entry.after?.[key];
      if (!Number.isSafeInteger(end) || end < before[key]) return 'invalid table reservation';
      if (!carried.has(key) && end !== before[key]) return 'unsupported table growth';
      slots += end - before[key];
    }
    // Budget serialized and decoded data conservatively, plus reserved slots.
    // This is transport accounting, not a bound on V8 executable memory.
    if (!Number.isSafeInteger(slots) || bytes * 2 + slots * 8 > this.availableBytes()) return 'entry exceeds transport budget';
    for (const [table, entries] of Object.entries(entry.payload?.siteTables || {})) {
      if (!Object.hasOwn(before, table) || !Array.isArray(entries)) return 'unknown site table';
      for (const site of entries) {
        if (!Number.isSafeInteger(site.index) || site.index < before[table] ||
            site.index >= entry.after[table]) return 'site is outside fresh reservation';
      }
    }
    return this.jit.resultStalenessReason(entry.payload);
  }

  async prepare(method, options) {
    if (this.busy) throw new Error('prepared cache permits only one operation in flight');
    this.busy = true;
    try { return await this.prepareOne(method, options); }
    finally { this.busy = false; }
  }

  async prepareOne(method, options) {
    const jit = this.jit;
    if (!this.enabled || !this.eligible() || jit.codegenCache.has(method)) {
      return jit.getGeneratedFunction(method, options);
    }
    const methodKey = `${jit.jvm.findClassNameForMethod(method)}.${method.name}${method.descriptor}`;
    // A method can fail early and compile in a later fixed-point round.
    // Keep those positions separate: a later body must not stop first-round
    // replay merely because the same method is visited there again.
    const key = JSON.stringify([this.identity, methodKey, jit.siteIdWatermark()]);
    if (this.replay) {
      let text;
      try { text = await this.store.get(key, Math.floor(this.availableBytes() / 2)); }
      catch (error) { this.enabled = false; this.stats.errors++; this.stats.lastError = String(error.message); }
      if (!this.eligible()) return jit.codegenCache.get(method) || null;
      if (text != null) {
        try {
          if (typeof text !== 'string' || text.length * 2 > this.availableBytes()) {
            this.refuse('entry exceeds transport budget');
          } else {
            const bytes = text.length * 2;
            this.stats.peakPayloadBytes = Math.max(this.stats.peakPayloadBytes, bytes);
            const entry = JSON.parse(text);
            const reason = this.validate(entry, methodKey, jit.siteIdWatermark(), bytes);
            if (reason) this.refuse(reason);
            else {
              jit.reserveSiteIdSpace(entry.after);
              const body = jit.materializeGeneratedResult(entry.payload, method);
              if (body) {
                jit.nonSpeculativeStaticBooleanMethods.add(method);
                jit.preparedCodegenMethods.add(method);
                jit.installedSourceRetention.apply(body);
                jit.codegenCache.set(method, body);
                // Admission may have rejected this method before restoration.
                // Recheck against the newly published, verified body.
                jit.adaptiveCodegenSupportCache.delete(method);
                this.stats.hits++;
                return body;
              }
              this.refuse(jit.lastTransportRefusal || jit.lastStaleTransportReason || 'materialization refused');
            }
          }
        } catch (error) { this.refuse(`invalid entry: ${error.message}`); }
      }
      text = null;
    }
    this.stats.misses++;
    // A refused materialization may have reserved fresh ranges. Capture the
    // actual fallback prefix, never the prefix of the rejected entry.
    const compileBefore = jit.siteIdWatermark();
    let record = null, recordedAfter = null;
    const body = jit.getGeneratedFunction(method, {...options, onGeneratedResult: generated => {
      if (!this.enabled || !generated || jit.untransportableTableGrowth(compileBefore).length) return;
      try {
        const payload = jit.serializeGeneratedResult(generated, {siteTablesSince:compileBefore});
        if (!payload) return;
        const entry = {version:1, identity:this.identity, method:methodKey,
          before:compileBefore, after:jit.siteIdWatermark(), payload};
        const text = JSON.stringify(entry), bytes = text.length * 2;
        if (this.validate(entry, methodKey, compileBefore, bytes)) return;
        record = text;
        recordedAfter = entry.after;
        this.stats.peakPayloadBytes = Math.max(this.stats.peakPayloadBytes, bytes);
      } catch (_) { /* Unserializable methods keep the ordinary compiled body. */ }
    }});
    if (record !== null && (JSON.stringify(recordedAfter) !== JSON.stringify(jit.siteIdWatermark()) ||
        record.length * 4 > this.availableBytes())) record = null;
    if (record !== null && this.enabled) {
      try { await this.store.put(key, record); this.stats.writes++; }
      catch (error) { this.enabled = false; this.stats.errors++; this.stats.lastError = String(error.message); }
      finally { record = null; }
    }
    return body;
  }
}

module.exports = {PreparedCodeCache};
