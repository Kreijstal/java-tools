'use strict';

const InstalledSourceRetention = require('./InstalledSourceRetention');

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
    // A development pack served to the page (dekobloko-work code-pack.mjs)
    // replays every prepared body, far more source than the retention
    // allowance; it opts out of that clamp and keeps only its own entry bound.
    this.ignoreRetentionBudget = options.ignoreRetentionBudget === true;
    if (!this.ignoreRetentionBudget) {
      this.limit = Math.min(this.limit, jit.installedSourceRetention.limit);
    }
    this.enabled = true;
    this.replay = true;
    this.busy = false;
    // Store entries without the diagnostic copies of generated source: the
    // keys InstalledSourceRetention may strip from any installed body, plus
    // the hot-call-graph region fragments, whose only reader is the region
    // compiler, and that compiler is off whenever this cache is eligible.
    this.dropDiagnosticSource = options.dropDiagnosticSource === true;
    // Transport may drop closures a receiving JIT can do without
    // (JitCompiler.transportOptionalKeys): a restored checked leaf then has
    // no row entry or lexical-insertion body for its callers. With this set
    // such a step is not stored, so the replay compiles it and keeps them.
    this.requireCompleteResults = options.requireCompleteResults === true;
    this.onUnrecorded = typeof options.onUnrecorded === 'function' ? options.onUnrecorded : null;
    this.stats = {hits:0, misses:0, writes:0, refused:0, errors:0, peakPayloadBytes:0,
      unrecorded:0, companions:0, restoreMs:0, counterNames:{}};
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
    if (this.ignoreRetentionBudget) return this.limit;
    return Math.max(0, Math.min(this.limit,
      this.jit.installedSourceRetention.limit - this.jit.installedSourceRetention.bytes));
  }

  validate(entry, methodKey, before, bytes) {
    if (entry?.version !== 2 || JSON.stringify(entry.identity) !== JSON.stringify(this.identity) ||
        entry.method !== methodKey) return 'cache identity differs';
    if (!['body', 'null', 'unpublished', 'kept', 'cached'].includes(entry.outcome) ||
        (entry.outcome === 'body') !== Boolean(entry.payload)) return 'invalid entry outcome';
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
    const tables = {...(entry.siteTables || {})};
    if (entry.instanceJreIntrinsics) {
      tables.directJreIntrinsics = [...(tables.directJreIntrinsics || []),
        ...entry.instanceJreIntrinsics];
    }
    for (const [table, entries] of Object.entries(tables)) {
      if (!Object.hasOwn(before, table) || !Array.isArray(entries)) return 'unknown site table';
      for (const site of entries) {
        if (!Number.isSafeInteger(site.index) || site.index < before[table] ||
            site.index >= entry.after[table]) return 'site is outside fresh reservation';
      }
    }
    for (const row of entry.companions || []) {
      const reason = row.payload ? this.jit.resultStalenessReason(row.payload) : null;
      if (reason) return reason;
    }
    return entry.payload ? this.jit.resultStalenessReason(entry.payload) : null;
  }

  async prepare(method, options) {
    if (this.busy) throw new Error('prepared cache permits only one operation in flight');
    this.busy = true;
    try { return await this.prepareOne(method, options); }
    finally { this.busy = false; }
  }

  async prepareOne(method, options) {
    const jit = this.jit;
    if (!this.enabled || !this.eligible()) {
      return jit.getGeneratedFunction(method, options);
    }
    // A method published before its own turn (a callee some earlier compile
    // built) is still a step: preparation may rebuild it as a whole-method
    // body here. A step that changes nothing stores nothing.
    const wasCached = jit.codegenCache.has(method);
    const previous = wasCached ? jit.codegenCache.get(method) : undefined;
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
            const restoreStart = jit.monotonicNow();
            const entry = JSON.parse(text);
            const reason = this.validate(entry, methodKey, jit.siteIdWatermark(), bytes);
            if (reason) this.refuse(reason);
            else {
              const restored = entry.outcome === 'cached'
                ? {body: jit.getGeneratedFunction(method, options)}
                : this.restore(entry, method);
              if (restored) {
                this.stats.hits++;
                this.stats.restoreMs += jit.monotonicNow() - restoreStart;
                return restored.body;
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
    let payload = null, compiled = null, refusal = null;
    // A compile may compile callees on the way (constructor proofs, call
    // targets). Their bodies are published by the nested getGeneratedFunction
    // calls and their site ids lie inside this compile's reservation, so they
    // belong to this entry: a replay that restored only the outer body would
    // compile them again later, at fresh ids, and every later key would miss.
    // Each is serialized as compileMethod returns it: getGeneratedFunction
    // may strip its source for the retention allowance right after.
    const nested = new Map();
    const compileMethod = jit.compileMethod;
    const ownCompileMethod = Object.hasOwn(jit, 'compileMethod');
    const cache = this;
    jit.compileMethod = function (target, ...rest) {
      const generated = compileMethod.call(this, target, ...rest);
      if (target !== method) {
        let nestedPayload = null;
        if (typeof generated === 'function' && cache.enabled) {
          try { nestedPayload = cache.serialize(generated); } catch (_) { nestedPayload = null; }
        }
        nested.delete(target);
        nested.set(target, {generated, payload: nestedPayload,
          refusal: nestedPayload ? null : jit.lastTransportRefusal});
      }
      return generated;
    };
    // Decisions the step cached about methods (admission verdicts, tier
    // preferences, prepared flags) are part of what it changed: a replay that
    // left them unset would let a later compile decide afresh.
    const journal = [];
    const unwatch = this.watchCollections(journal);
    const workerBefore = this.workerState();
    const countersBefore = this.counters();
    let body;
    try {
      body = jit.getGeneratedFunction(method, {...options, onGeneratedResult: generated => {
        compiled = generated;
        if (!this.enabled || !generated) return;
        try { payload = this.serialize(generated); }
        catch (error) { refusal = `serialization failed: ${error.message}`; return; }
        if (!payload) refusal = jit.lastTransportRefusal || 'not serializable';
      }});
    } finally {
      unwatch();
      if (ownCompileMethod) jit.compileMethod = compileMethod;
      else delete jit.compileMethod;
    }
    let record = null;
    if (this.enabled) {
      const described = this.describeEntry(method, methodKey, compileBefore, body,
        compiled, payload, refusal, nested, wasCached, previous, journal, workerBefore,
        countersBefore);
      if (typeof described === 'string') {
        this.stats.unrecorded++;
        this.stats.lastUnrecorded = described;
        if (this.onUnrecorded) this.onUnrecorded(methodKey, described);
      } else {
        record = described.text;
      }
    }
    if (record !== null && this.enabled) {
      try { await this.store.put(key, record); this.stats.writes++; }
      catch (error) { this.enabled = false; this.stats.errors++; this.stats.lastError = String(error.message); }
      finally { record = null; }
    }
    return body;
  }

  // Everything one preparation step changed that a replay must reproduce:
  // the published body (or the published null of a failed compile, or no
  // publication at all), every site-table entry the step allocated with the
  // caller each call site belongs to, and the callees compiled on the way.
  // Returns {text}, or the reason the step cannot be stored.
  describeEntry(method, methodKey, before, body, compiled, payload, refusal, nested,
    wasCached = false, previous = undefined, journal = [], workerBefore = null,
    countersBefore = {}) {
    const jit = this.jit;
    const after = jit.siteIdWatermark();
    const growth = jit.untransportableTableGrowth(before);
    if (growth.length) return `untransportable tables: ${growth.join(', ')}`;
    const published = jit.codegenCache.has(method);
    const current = published ? jit.codegenCache.get(method) : undefined;
    const kept = wasCached && published && current === previous;
    const moved = JSON.stringify(after) !== JSON.stringify(before);
    const decisions = this.describeJournal(journal);
    if (typeof decisions === 'string') return decisions;
    const workerAfter = this.workerState();
    const workerChanged = workerBefore !== workerAfter;
    const countersAfter = this.counters();
    const counters = {};
    for (const [name, value] of Object.entries(countersAfter)) {
      if (countersBefore[name] !== value) counters[name] = value;
    }
    const countersChanged = Object.keys(counters).length > 0;
    for (const name of Object.keys(counters)) this.stats.counterNames[name] = true;
    if (kept && !moved && !nested.size && !decisions.length && !workerChanged &&
        !countersChanged) {
      // The ordinary cached path: at most the prepared flags change, and the
      // replay takes the same cached path. Stored as a marker so the replay
      // knows the step was seen.
      const entry = {version:2, identity:this.identity, method:methodKey, before, after,
        outcome:'cached', payload:null, siteTables:null};
      return {text: JSON.stringify(entry)};
    }
    if (refusal && !kept) return refusal;
    const outcome = kept ? 'kept' : !published ? 'unpublished' : current ? 'body' : 'null';
    if (outcome === 'body' && (!payload || current !== compiled)) {
      return 'published body is not the compiled one';
    }
    if (outcome !== 'body') payload = null;
    const dropped = payload ? droppedKeys(payload) : [];
    if (this.requireCompleteResults && dropped.length) {
      return `transport drops ${dropped.join(', ')}`;
    }
    // What the rebuild path of getGeneratedFunction did with a replaced body.
    const upgrade = !wasCached || kept ? null : current ? 'publish' : 'withdraw';
    let tables;
    try { tables = this.describeTables(before); }
    catch (error) { return `site tables: ${error.message}`; }
    const companions = this.describeCompanions(nested);
    if (typeof companions === 'string') return companions;
    if (this.dropDiagnosticSource && payload) dropDiagnosticSource(payload);
    const entry = {version:2, identity:this.identity, method:methodKey, before, after,
      outcome, payload: outcome === 'body' ? payload : null, siteTables: tables.siteTables,
      prepared: jit.preparedCodegenMethods.has(method),
      nonSpeculative: jit.nonSpeculativeStaticBooleanMethods.has(method)};
    if (upgrade) entry.upgrade = upgrade;
    if (decisions.length) entry.decisions = decisions;
    if (workerChanged) entry.worker = JSON.parse(workerAfter);
    if (countersChanged) entry.counters = counters;
    // Which functions kept their source under the retention allowance, and
    // the allowance's account after the step. A restored body carries no
    // diagnostic copies, so its own size would decide differently.
    const retention = jit.installedSourceRetention;
    entry.retention = {bytes: retention.bytes, strippedBodies: retention.strippedBodies,
      body: outcome === 'body' ? retentionShape(current) : null,
      companions: companions.map(row => {
        const target = this.resolveMethod(row.className, row.name, row.descriptor);
        const published = target ? jit.codegenCache.get(target) : null;
        return typeof published === 'function' ? retentionShape(published) : null;
      })};
    if (tables.instanceJreIntrinsics.length) entry.instanceJreIntrinsics = tables.instanceJreIntrinsics;
    if (companions.length) entry.companions = companions;
    const owners = this.describeSiteOwners(method, before);
    if (owners.length) entry.siteOwners = owners;
    const text = JSON.stringify(entry), bytes = text.length * 2;
    // A link record serialization could not name (see describeLinkRecords)
    // cannot be interned on replay.
    if (text.includes('"kind":"unknown"')) return 'body captures an unknown link record';
    const invalid = this.validate(entry, methodKey, before, bytes);
    if (invalid) return invalid;
    if (text.length * 4 > this.availableBytes()) return 'entry exceeds transport budget';
    this.stats.peakPayloadBytes = Math.max(this.stats.peakPayloadBytes, bytes);
    return {text};
  }

  // describeSiteTablesSince, plus the instance direct-JRE intrinsics the
  // worker protocol does not describe. Those are bound exactly as
  // getCompileTimeDirectJre binds them locally (see placeInstanceIntrinsics).
  describeTables(from) {
    const jit = this.jit;
    const siteTables = jit.describeSiteTablesSince(
      {...from, directJreIntrinsics: jit.directJreIntrinsics.length});
    const instanceJreIntrinsics = [];
    for (let id = from.directJreIntrinsics; id < jit.directJreIntrinsics.length; id++) {
      if (!jit.directJreIntrinsics[id]) continue;
      const descriptor = jit.directJreDescriptors.get(id);
      if (!descriptor) throw new Error(`direct JRE intrinsic ${id} has no descriptor`);
      (descriptor.isStatic ? siteTables.directJreIntrinsics : instanceJreIntrinsics)
        .push({index: id, ...descriptor});
    }
    return {siteTables, instanceJreIntrinsics};
  }

  // Replay one stored step against this JIT. Null when any part cannot be
  // placed; nothing is published before every part is ready.
  restore(entry, method) {
    const jit = this.jit;
    jit.reserveSiteIdSpace(entry.after);
    if (!this.placeInstanceIntrinsics(entry.instanceJreIntrinsics)) return null;
    const tables = entry.siteTables || {};
    const conflict = jit.placeSiteTables({...tables, syncCallSites: []}, method);
    if (conflict) { jit.lastStaleTransportReason = conflict; return null; }
    if (!this.placeCallSites(tables.syncCallSites || [], entry.siteOwners || [], method)) return null;
    let body = null;
    if (entry.outcome === 'body') {
      // Every table entry is placed above; the payload carries none.
      entry.payload.siteTables = null;
      body = jit.materializeGeneratedResult(entry.payload, method);
      if (!body) return null;
    }
    // Callees the recorded compile built on the way, each restored as the
    // nested getGeneratedFunction published it. All or nothing: a partial
    // set would leave the next lookups out of step.
    const companions = this.materializeCompanions(entry.companions);
    if (!companions) return null;
    const retention = entry.retention;
    companions.forEach((companion, index) => this.install(companion,
      retention ? retention.companions?.[index] ?? null : undefined));
    if (entry.nonSpeculative) jit.nonSpeculativeStaticBooleanMethods.add(method);
    if (entry.outcome === 'body') {
      if (retention) applyRetentionShape(jit.installedSourceRetention, body, retention.body);
      else jit.installedSourceRetention.apply(body);
      jit.codegenCache.set(method, body);
      jit.trackLazyStaticOwners(method, body);
    } else if (entry.outcome === 'null') {
      jit.codegenCache.set(method, null);
    } else if (entry.outcome === 'unpublished') {
      jit.codegenCache.delete(method);
    } else {
      body = jit.codegenCache.get(method) ?? null;
    }
    if (retention) {
      jit.installedSourceRetention.bytes = retention.bytes;
      jit.installedSourceRetention.strippedBodies = retention.strippedBodies;
    }
    if (entry.prepared) jit.preparedCodegenMethods.add(method);
    if (entry.upgrade === 'publish') jit.publishGeneratedTargetUpgrade(method, body);
    else if (entry.upgrade === 'withdraw') jit.withdrawGeneratedTarget(method);
    if (entry.worker) this.applyWorkerState(entry.worker);
    if (entry.counters && !this.applyCounters(entry.counters)) return null;
    if (entry.decisions) {
      // Exactly the verdicts the recorded step left behind.
      if (!this.applyDecisions(entry.decisions)) return null;
    } else {
      // Admission may have rejected this method before restoration.
      // Recheck against the newly published, verified body.
      jit.adaptiveCodegenSupportCache.delete(method);
    }
    this.stats.companions += companions.length;
    return {body};
  }

  // The JIT's method-keyed collections whose values are plain data. Others
  // are rebuilt by placement and installation (call sites by caller, link
  // targets, static version cells) or are pure functions of the bytecode
  // recomputed on demand (normalized items, loop analyses).
  watchedCollections() {
    if (this.collections) return this.collections;
    const skip = new Set(['codegenCache', 'codegenCompiling', 'syncCallSitesByCaller',
      'directJreDescriptors', 'staticFieldVersionCells', 'directCheckedLeafBodyIds',
      'lazyStaticRelinkDependents']);
    const found = [];
    for (const [ownerName, owner] of [['jit', this.jit], ['structuredSsa', this.jit.structuredSsa],
      ['compileWorker', this.jit.compileWorker]]) {
      if (!owner) continue;
      for (const name of Object.keys(owner)) {
        const collection = owner[name];
        if (skip.has(name) || !(collection instanceof Map || collection instanceof WeakMap ||
            collection instanceof Set || collection instanceof WeakSet)) continue;
        found.push({path: `${ownerName}.${name}`, owner, name});
      }
    }
    this.collections = found;
    return found;
  }

  watchCollections(journal) {
    const undo = [];
    for (const {path, owner, name} of this.watchedCollections()) {
      const collection = owner[name];
      for (const op of ['set', 'add', 'delete']) {
        if (typeof collection[op] !== 'function') continue;
        const original = collection[op];
        const own = Object.hasOwn(collection, op);
        collection[op] = function (key, value) {
          journal.push([path, op, key, value]);
          return original.call(this, key, value);
        };
        undo.push(() => { if (own) collection[op] = original; else delete collection[op]; });
      }
    }
    return () => { for (const step of undo) step(); };
  }

  // [path, op, [class, name, descriptor], value] rows; only method keys and
  // plain values are kept. A reason string when a row cannot be carried.
  describeJournal(journal) {
    const jit = this.jit;
    const out = [];
    const plain = (value) => value === undefined || value === null ||
      ['boolean', 'number', 'string'].includes(typeof value);
    for (const [path, op, key, value] of journal) {
      const isMethod = key && typeof key === 'object' && typeof key.name === 'string' &&
        typeof key.descriptor === 'string';
      if (!isMethod) continue;
      if (op === 'set' && !plain(value)) continue;
      const className = jit.jvm.findClassNameForMethod(key);
      if (!className) return `decision about an unowned method in ${path}`;
      out.push([path, op, [className, key.name, key.descriptor],
        op === 'set' ? (value === undefined ? {undefined: true} : value) : null]);
    }
    return out;
  }

  applyDecisions(rows) {
    const jit = this.jit;
    const owners = {jit, structuredSsa: jit.structuredSsa, compileWorker: jit.compileWorker};
    for (const [path, op, [className, name, descriptor], value] of rows) {
      const [ownerName, collectionName] = path.split('.');
      const collection = owners[ownerName]?.[collectionName];
      const target = this.resolveMethod(className, name, descriptor);
      if (!collection || !target || typeof collection[op] !== 'function') {
        jit.lastTransportRefusal = `cannot apply ${path}.${op} for ${className}.${name}`;
        return false;
      }
      if (op === 'set') {
        collection.set(target, value && typeof value === 'object' && value.undefined ? undefined : value);
      } else {
        collection[op](target);
      }
    }
    return true;
  }

  // Numeric fields of the JIT and the structured renderer a compile advances:
  // name counters (SSA value names and compile serials are unique across
  // compiles, so a later compile's text depends on them) and allocator
  // positions. Accounting -- counts, times, sizes -- is left alone, so the
  // replay reports its own work.
  counters() {
    const out = {};
    const accounting = /(Count|Counts|Ms|Bytes|Depth)$/;
    for (const [ownerName, owner] of [['jit', this.jit], ['structuredSsa', this.jit.structuredSsa]]) {
      if (!owner) continue;
      for (const name of Object.keys(owner)) {
        const value = owner[name];
        if (typeof value !== 'number' || accounting.test(name)) continue;
        out[`${ownerName}.${name}`] = value;
      }
    }
    return out;
  }

  applyCounters(counters) {
    const owners = {jit: this.jit, structuredSsa: this.jit.structuredSsa};
    for (const [path, value] of Object.entries(counters)) {
      const [ownerName, name] = path.split('.');
      const owner = owners[ownerName];
      if (!owner || typeof value !== 'number') {
        this.jit.lastTransportRefusal = `cannot restore counter ${path}`;
        return false;
      }
      owner[name] = value;
    }
    return true;
  }

  // The compile worker client is part of what a step changes: a nested
  // compile is first offered to it, and a host without a worker declines and
  // counts the failure until the client switches itself off. Its plain
  // fields, as text (collections are journaled with the JIT's).
  workerState() {
    const worker = this.jit.compileWorker;
    if (!worker) return null;
    return JSON.stringify({enabled: worker.enabled,
      consecutiveSendFailures: worker.consecutiveSendFailures,
      nextRequestId: worker.nextRequestId, lastRefusal: worker.lastRefusal ?? null,
      firstSendError: worker.firstSendError ?? null, stats: worker.stats,
      queued: worker.queue.length, inFlight: worker.inFlight.size,
      hasWorker: Boolean(worker.worker)});
  }

  applyWorkerState(state) {
    const worker = this.jit.compileWorker;
    if (!worker || state.queued || state.inFlight || state.hasWorker) return false;
    worker.enabled = state.enabled;
    worker.consecutiveSendFailures = state.consecutiveSendFailures;
    worker.nextRequestId = state.nextRequestId;
    worker.lastRefusal = state.lastRefusal;
    if (state.firstSendError !== null) worker.firstSendError = state.firstSendError;
    worker.stats = JSON.parse(JSON.stringify(state.stats));
    return true;
  }

  placeInstanceIntrinsics(list = []) {
    const jit = this.jit;
    for (const entry of list) {
      const {className, methodName, descriptor, index} = entry;
      const native = jit.resolveSynchronousJreMethod(className, className, methodName, descriptor);
      if (entry.isStatic || native?.jvmDirectFinal !== true ||
          typeof native.jvmDirectIntrinsic !== 'function' ||
          JSON.stringify(native.jvmDirectFieldWriteKeys ?? null) !==
            JSON.stringify(entry.fieldWriteKeys ?? null)) {
        jit.lastTransportRefusal = `direct JRE intrinsic ${className}.${methodName}${descriptor} does not resolve here`;
        return false;
      }
      if (jit.directJreIntrinsics[index]) {
        jit.lastTransportRefusal = `direct JRE intrinsic ${index} is already occupied`;
        return false;
      }
      jit.directJreIntrinsics[index] = native.jvmDirectIntrinsic;
      jit.directJreDescriptors.set(index, {className, methodName, descriptor, isStatic: false,
        fieldWriteKeys: Array.isArray(entry.fieldWriteKeys) ? [...entry.fieldWriteKeys] : null});
      jit.directJreInitializationTokens[index] = null;
    }
    return true;
  }

  // serializeGeneratedResult, without the hot-call-graph region insertions
  // when dropDiagnosticSource is set: like the region fragments, their only
  // readers are the region compiler (off whenever this cache is eligible) and
  // the single-site experiment, and they are closures no entry can carry.
  serialize(generated, options = {}) {
    if (!this.dropDiagnosticSource) return this.jit.serializeGeneratedResult(generated, options);
    const hidden = [];
    const hide = (fn) => {
      if (typeof fn !== 'function') return;
      for (const key of regionInsertionKeys) {
        // A null insertion is plain data and travels as it is.
        if (Object.hasOwn(fn, key) && fn[key] != null) {
          hidden.push([fn, key, fn[key]]);
          delete fn[key];
        }
      }
    };
    hide(generated);
    hide(generated?.jvmFastBody);
    hide(generated?.jvmResumeBodyFn);
    try { return this.jit.serializeGeneratedResult(generated, options); }
    finally { for (const [fn, key, value] of hidden) fn[key] = value; }
  }

  // The published state of each callee compiled inside the current compile:
  // its body (serialized without site tables -- the outer entry carries every
  // id the compile allocated) or a published null. A reason string when one
  // cannot be carried, which leaves the whole entry unrecorded.
  describeCompanions(nested) {
    const jit = this.jit;
    const out = [];
    for (const [target, compiled] of nested) {
      if (!jit.codegenCache.has(target)) return 'nested compile left no published state';
      const className = jit.jvm.findClassNameForMethod(target);
      if (!className) return 'nested compile has no owner class';
      const generated = jit.codegenCache.get(target);
      const row = {className, name:target.name, descriptor:target.descriptor,
        prepared:jit.preparedCodegenMethods.has(target),
        nonSpeculative:jit.nonSpeculativeStaticBooleanMethods.has(target),
        payload:null};
      if (generated) {
        if (generated !== compiled.generated) {
          return `nested ${className}.${target.name}: published body is not the compiled one`;
        }
        if (!compiled.payload) {
          return `nested ${className}.${target.name}: ${compiled.refusal || 'not serializable'}`;
        }
        row.payload = compiled.payload;
        const dropped = droppedKeys(row.payload);
        if (this.requireCompleteResults && dropped.length) {
          return `nested ${className}.${target.name}: transport drops ${dropped.join(', ')}`;
        }
        if (this.dropDiagnosticSource) dropDiagnosticSource(row.payload);
      }
      out.push(row);
    }
    return out;
  }

  // Call sites this compile allocated on behalf of another caller: the
  // callees it compiled on the way, or no caller at all. Transport places
  // every site under the entry's own method, so these travel with their
  // owner and are placed under it before the entry is materialized.
  describeSiteOwners(method, before) {
    const jit = this.jit;
    const owners = [];
    for (let id = before.syncCallSites; id < jit.syncCallSites.length; id++) {
      const site = jit.syncCallSites[id];
      if (!site || site.callerMethod === method) continue;
      const owner = site.callerMethod;
      owners.push([id, owner ? [jit.jvm.findClassNameForMethod(owner), owner.name,
        owner.descriptor] : null]);
    }
    return owners;
  }

  resolveMethod(className, name, descriptor) {
    const owner = this.jit.jvm.classes?.[className];
    const item = (owner?.ast?.classes?.[0]?.items || []).find(entry =>
      entry?.type === 'method' && entry.method?.name === name &&
      entry.method?.descriptor === descriptor);
    return item ? item.method : null;
  }

  // Call sites go in as the compile registered them: one fresh record per
  // index under the caller that owned it. placeSiteTables would alias a
  // second registration of the same bytecode site (a compile registers one
  // per tier) to the first, and transport's cold-site prewarming is not
  // something the local compile did.
  placeCallSites(sites, owners, method) {
    const jit = this.jit;
    const ownerOf = new Map(owners.map(([index, owner]) => [index, owner]));
    const resolved = new Map();
    for (const site of sites) {
      let caller = method;
      if (ownerOf.has(site.index)) {
        const owner = ownerOf.get(site.index);
        const key = JSON.stringify(owner);
        if (!resolved.has(key)) resolved.set(key, owner ? this.resolveMethod(...owner) : null);
        caller = resolved.get(key);
        if (owner && !caller) { jit.lastTransportRefusal = `site owner ${owner.join('.')} is not loaded`; return false; }
      }
      const existing = jit.syncCallSites[site.index];
      if (existing) {
        jit.lastStaleTransportReason = `call site ${site.index} is already ${existing.declaredClassName}.${existing.methodName}`;
        return false;
      }
      jit.registerSyncCallSite(site.op,
        {arg: ['Method', site.className, [site.methodName, site.descriptor]]},
        caller, site.callerPc, site.index);
    }
    return true;
  }

  materializeCompanions(rows = []) {
    const jit = this.jit;
    const out = [];
    for (const row of rows) {
      const target = this.resolveMethod(row.className, row.name, row.descriptor);
      if (!target) { jit.lastTransportRefusal = `nested ${row.className}.${row.name} is not loaded`; return null; }
      let body = null;
      if (row.payload) {
        body = jit.materializeGeneratedResult(row.payload, target);
        if (!body) return null;
      }
      out.push({target, body, row});
    }
    return out;
  }

  // What getGeneratedFunction does after a nested compile, replayed.
  install({target, body, row}, shape = undefined) {
    const jit = this.jit;
    if (row.nonSpeculative) jit.nonSpeculativeStaticBooleanMethods.add(target);
    if (body && shape !== undefined) applyRetentionShape(jit.installedSourceRetention, body, shape);
    else if (body) jit.installedSourceRetention.apply(body);
    jit.codegenCache.set(target, body);
    if (body) jit.trackLazyStaticOwners(target, body);
    if (row.prepared) jit.preparedCodegenMethods.add(target);
    jit.adaptiveCodegenSupportCache.delete(target);
  }
}

const diagnosticDataKeys = new Set([...InstalledSourceRetention.sourceKeys,
  'jvmStructuredRegionFragments']);

const regionInsertionKeys = ['jvmInternalRegionPositionalInsertion',
  'jvmRestoringDirectPositionalInsertion'];

// Every generated function reachable from a body through jvm* properties,
// by property path (keys in sorted order, first path wins), with whether it
// still carries source. The same walk on a restored body finds the same paths.
function walkGenerated(body, visit) {
  const seen = new Set();
  const walk = (fn, path) => {
    if (typeof fn !== 'function' || seen.has(fn)) return;
    seen.add(fn);
    visit(fn, path);
    for (const key of Object.keys(fn).sort()) {
      if (key.startsWith('jvm') && typeof fn[key] === 'function') {
        walk(fn[key], path ? `${path}.${key}` : key);
      }
    }
  };
  walk(body, '');
}

function retentionShape(body) {
  const shape = {};
  walkGenerated(body, (fn, path) => {
    shape[path] = InstalledSourceRetention.sourceKeys.some(key => fn[key] != null);
  });
  return shape;
}

function applyRetentionShape(retention, body, shape) {
  walkGenerated(body, (fn, path) => {
    if (shape && shape[path] === false) {
      for (const key of InstalledSourceRetention.sourceKeys) delete fn[key];
    }
    retention.seen.add(fn);
  });
}

function droppedKeys(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.kind === 'resume-dispatcher') {
    return [...new Set([...droppedKeys(payload.fast), ...droppedKeys(payload.resume)])];
  }
  return [...(payload.dropped || [])];
}

function dropDiagnosticSource(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.kind === 'resume-dispatcher') {
    dropDiagnosticSource(payload.fast);
    dropDiagnosticSource(payload.resume);
    return;
  }
  for (const key of Object.keys(payload.data || {})) {
    if (diagnosticDataKeys.has(key)) delete payload.data[key];
  }
}

module.exports = {PreparedCodeCache, dropDiagnosticSource};
