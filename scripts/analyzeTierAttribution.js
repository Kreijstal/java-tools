'use strict';

/*
 * Attribute a V8 CPU profile's self time across JVM execution tiers.
 *
 * The question this answers is "where does guest wall time actually go",
 * which is NOT the same as the ownership question ("which tier compiled the
 * method"). Ownership counts methods; this counts samples. It exists because
 * JVM_PROFILE_HOT_METHODS disables JIT fast paths (WasmJit.js), so the
 * built-in profiler cannot measure the tiering it perturbs. V8 sampling does
 * not change tier selection, so it can.
 *
 * Generated guest bodies are identifiable without any added instrumentation:
 * JitCompiler.generatedSource stamps every emitted function with
 *   //# sourceURL=jvm-generated://<owner>/<method>?tier=<tier>
 * so samples land on a URL that names the tier that produced the code.
 *
 * Usage:
 *   node scripts/analyzeTierAttribution.js PROFILE [--top N] [--json]
 *                                                  [--bucket NAME]
 */

const fs = require('fs');

function usage() {
  return [
    'Usage: node scripts/analyzeTierAttribution.js PROFILE [options]',
    '',
    '  --top N        rows per table (default 40)',
    '  --bucket NAME  drill into one bucket, listing its functions',
    '  --census FILE  annotate --guest rows with the JVM_WASM_CENSUS_FILE',
    '                 verdict for that method',
    '  --json         emit machine-readable output',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {top: 40, json: false, bucket: null, runs: null,
    guest: false, profile: null, census: null};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return {help: true};
    if (argument === '--json') { options.json = true; continue; }
    if (!argument.startsWith('--')) {
      if (options.profile) throw new Error('Only one profile may be given.');
      options.profile = argument;
      continue;
    }
    const name = argument.slice(2);
    if (name === 'guest') { options.guest = true; continue; }
    if (!['top', 'bucket', 'runs', 'census'].includes(name)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${argument}`);
    options[name] = argv[++index];
  }
  if (!options.profile) throw new Error('A .cpuprofile path is required.');
  options.top = Number(options.top);
  if (!Number.isInteger(options.top) || options.top < 1) {
    throw new Error('--top must be a positive integer.');
  }
  return options;
}

/*
 * Tier of a generated body, read from the sourceURL query rather than guessed
 * from the function name, so a renamed tier cannot silently rebucket samples.
 */
function generatedTier(url) {
  const marker = url.indexOf('?tier=');
  if (marker < 0) return 'unknown';
  return decodeURIComponent(url.slice(marker + 6).split('&')[0]);
}

function classify(entry) {
  const {url, functionName} = entry;
  if (url.startsWith('jvm-generated:')) {
    return {bucket: `guest:${generatedTier(url)}`, group: 'guest-compiled'};
  }
  if (url.startsWith('wasm:') || /^wasm-function/.test(functionName)) {
    return {bucket: 'guest:wasm', group: 'guest-compiled'};
  }
  if (functionName === '(garbage collector)') {
    return {bucket: 'gc', group: 'host'};
  }
  if (functionName === '(idle)' || functionName === '(program)') {
    return {bucket: functionName === '(idle)' ? 'idle' : 'vm-internal',
      group: 'host'};
  }
  if (url.includes('/src/instructions/')) {
    return {bucket: 'interpreter:opcode', group: 'interpreter'};
  }
  if (url.includes('/src/jit/')) {
    return {bucket: 'runtime:jit', group: 'runtime'};
  }
  if (url.includes('/src/core/')) {
    return {bucket: 'runtime:core', group: 'runtime'};
  }
  if (url.includes('/src/jre/')) {
    return {bucket: 'jre-native', group: 'runtime'};
  }
  if (url.startsWith('node:')) return {bucket: 'node-runtime', group: 'host'};
  if (url.includes('/node_modules/')) {
    return {bucket: 'node-modules', group: 'host'};
  }
  return {bucket: 'other', group: 'host'};
}

/*
 * The census keys methods as `pkg.Class.name(desc)ret`; the profile's
 * sourceURL keys them as `pkg/Class/name(desc)ret`. Normalise both to
 * slash-separated so the two can be joined.
 */
function censusKey(method) {
  const paren = method.indexOf('(');
  if (paren < 0) return method.replace(/[./]/g, '/');
  return `${method.slice(0, paren).replace(/[./]/g, '/')}${method.slice(paren)}`;
}

function loadCensus(file) {
  const parsed = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const map = new Map();
  for (const row of parsed.methods) map.set(censusKey(row.method), row);
  return map;
}

function censusRow(census, method) {
  return census.get(censusKey(method)) || null;
}

/*
 * Mirror of wasmShared.wasmProfilerName: the name V8 reports for a wasm frame.
 * It is lossy (every non-identifier character becomes '_'), so it cannot be
 * parsed back into a method — but it CAN be recomputed from a known method,
 * which is enough to join in reverse.
 */
function wasmProfilerName(className, rest) {
  return `jvm$wasm$${className}$${rest}`.replace(/[^A-Za-z0-9_$]/g, '_');
}

/*
 * Samples taken inside a wasm module are attributed to `wasm://wasm/<hash>`,
 * so merging guest rows on the URL files every wasm-resident method under an
 * anonymous hash. That silently drops exactly the methods the gate DID admit
 * into a `not-seen` bucket — i.e. it under-reports coverage precisely where
 * coverage exists. Rebuild the mapping from the census side, which knows the
 * real names, and key wasm rows by the method they belong to so they merge
 * with that method's JS-tier samples.
 */
function wasmNameIndex(census) {
  const index = new Map();
  const ambiguous = new Set();
  for (const key of census.keys()) {
    const paren = key.indexOf('(');
    const head = paren < 0 ? key : key.slice(0, paren);
    const cut = head.lastIndexOf('/');
    if (cut < 0) continue;
    const className = head.slice(0, cut);
    const rest = `${head.slice(cut + 1)}${paren < 0 ? '' : key.slice(paren)}`;
    const mangled = wasmProfilerName(className, rest);
    if (index.has(mangled) && index.get(mangled) !== key) ambiguous.add(mangled);
    index.set(mangled, key);
  }
  // A collision would silently merge two methods' time; drop those rather
  // than report a number built on one.
  for (const mangled of ambiguous) index.delete(mangled);
  return {index, collisions: ambiguous.size};
}

/*
 * The dominant reason the gate turned this method away, or how well it ran
 * when it got in. "not-seen" means the wasm gate was never consulted at all,
 * which is a different problem from being rejected by it.
 */
function dominantReason(row) {
  if (!row) return 'not-seen';
  const entries = Object.entries(row.reasons)
    .sort((left, right) => right[1] - left[1]);
  if (!entries.length) return 'not-seen';
  const [reason] = entries[0];
  // A method that ever entered is covered, however many times it was also
  // turned away while warming up; ranking by count alone would report the
  // warmup reject as the verdict for a method wasm actually runs.
  if (row.reasons.entered) return 'entered';
  if (row.reasons['entered-osr']) return 'entered-osr';
  return reason;
}

/*
 * Weighted verdict table: how much guest-compiled WALL TIME sits behind each
 * gate outcome. The per-method annotation answers "why was this one turned
 * away"; this answers "what would closing that reason be worth", which is the
 * only form in which coverage work can be prioritised. Counting methods
 * instead of time ranks a cold method called twice above a 5-second loop.
 */
function censusSummary(ranked, census, guestTotal) {
  const byReason = new Map();
  for (const row of ranked) {
    const method = decodeURIComponent(row.key);
    const reason = dominantReason(censusRow(census, method));
    const bucket = byReason.get(reason) ||
      {reason, micros: 0, methods: 0};
    bucket.micros += row.micros;
    bucket.methods += 1;
    byReason.set(reason, bucket);
  }
  const rows = [...byReason.values()]
    .sort((left, right) => right.micros - left.micros);
  const out = [`\nWASM GATE VERDICTS BY GUEST TIME ` +
    `(${(guestTotal / 1e6).toFixed(1)}s guest-compiled)`];
  out.push(`${'ms'.padStart(9)} ${'%guest'.padStart(7)} ` +
    `${'methods'.padStart(8)}  verdict`);
  for (const row of rows) {
    out.push(`${(row.micros / 1000).toFixed(0).padStart(9)} ` +
      `${(row.micros * 100 / guestTotal).toFixed(1).padStart(7)} ` +
      `${String(row.methods).padStart(8)}  ${row.reason}`);
  }
  const covered = rows.filter((row) =>
    row.reason === 'entered' || row.reason === 'entered-osr')
    .reduce((sum, row) => sum + row.micros, 0);
  out.push(`${'—'.padStart(9)} ${(covered * 100 / guestTotal).toFixed(1)
    .padStart(7)} ${''.padStart(8)}  COVERED (entered + entered-osr)`);
  // How much of the time the gate turned away, or was never asked about, sits
  // in methods whose module COVERS the whole body. That is the only slice a
  // tier-preference change could claim without risking the runs==exits
  // thrash, so it is the honest size of that lever -- always smaller than the
  // raw bucket totals above.
  let fullElsewhere = 0;
  let fullMethods = 0;
  let compiledElsewhere = 0;
  for (const row of ranked) {
    const entry = censusRow(census, decodeURIComponent(row.key));
    if (!entry || entry.full === undefined) continue;
    const reason = dominantReason(entry);
    if (reason === 'entered' || reason === 'entered-osr') continue;
    compiledElsewhere += row.micros;
    if (entry.full) { fullElsewhere += row.micros; fullMethods += 1; }
  }
  if (compiledElsewhere) {
    out.push(`${(fullElsewhere / 1000).toFixed(0).padStart(9)} ` +
      `${(fullElsewhere * 100 / guestTotal).toFixed(1).padStart(7)} ` +
      `${String(fullMethods).padStart(8)}  ` +
      `of which: NOT covered but module is fullyCompiled ` +
      `(safe tier-preference headroom)`);
  }
  return out.join('\n');
}

function censusVerdict(census, method) {
  const row = censusRow(census, method);
  if (!row) return '[not-seen]';
  const entries = Object.entries(row.reasons)
    .sort((left, right) => right[1] - left[1]);
  const total = entries.reduce((sum, entry) => sum + entry[1], 0) || 1;
  const [reason, count] = entries[0];
  const share = (count * 100 / total).toFixed(0);
  const ran = row.runs
    ? ` runs=${row.runs} exits=${row.exits}` : '';
  const gap = row.uncovered
    ? ` gap:${Object.entries(row.uncovered).slice(0, 4)
      .map(([op, count]) => `${op}x${count}`).join(',')}` : '';
  return `[${reason} ${share}% of ${total}${ran}${gap}]`;
}

function shortUrl(url) {
  if (!url) return '';
  if (url.startsWith('jvm-generated:')) {
    return url.replace('jvm-generated://', '').split('?')[0];
  }
  const marker = url.lastIndexOf('/src/');
  if (marker >= 0) return url.slice(marker + 1);
  return url.replace(/^file:\/\//, '').split('/').slice(-2).join('/');
}

function analyze(profile) {
  const selfSamples = new Map();
  const samples = profile.samples || [];
  // Prefer real per-sample deltas: the sampler is not perfectly periodic, and
  // over a multi-minute window the drift is large enough to matter.
  const deltas = profile.timeDeltas || null;
  const selfMicros = new Map();
  for (let index = 0; index < samples.length; index++) {
    const id = samples[index];
    selfSamples.set(id, (selfSamples.get(id) || 0) + 1);
    const delta = deltas && Number.isFinite(deltas[index]) ? deltas[index] : 0;
    // Negative deltas appear in some V8 builds; clamp rather than subtract.
    selfMicros.set(id, (selfMicros.get(id) || 0) + Math.max(0, delta));
  }
  const totalSamples = samples.length;
  let totalMicros = 0;
  for (const micros of selfMicros.values()) totalMicros += micros;
  const wallMicros = profile.endTime > profile.startTime
    ? profile.endTime - profile.startTime : totalMicros;

  const rows = [];
  for (const node of profile.nodes || []) {
    const count = selfSamples.get(node.id) || 0;
    if (!count) continue;
    const call = node.callFrame || {};
    const entry = {
      functionName: call.functionName || '(anonymous)',
      url: call.url || '',
      line: Number(call.lineNumber || 0) + 1,
      samples: count,
      micros: selfMicros.get(node.id) || 0,
    };
    Object.assign(entry, classify(entry));
    rows.push(entry);
  }
  rows.sort((left, right) => right.micros - left.micros);

  // Merge nodes that are the same function reached by different call paths;
  // V8 emits one node per path, so raw nodes understate a hot helper.
  const merged = new Map();
  for (const row of rows) {
    const key = `${row.bucket} ${row.functionName} ${row.url}`;
    const existing = merged.get(key);
    if (existing) {
      existing.samples += row.samples;
      existing.micros += row.micros;
    } else merged.set(key, {...row});
  }
  const functions = [...merged.values()]
    .sort((left, right) => right.micros - left.micros);

  const sumInto = (keyFor) => {
    const sums = new Map();
    for (const row of functions) {
      const key = keyFor(row);
      const existing = sums.get(key) || {key, samples: 0, micros: 0};
      existing.samples += row.samples;
      existing.micros += row.micros;
      sums.set(key, existing);
    }
    return [...sums.values()].sort((left, right) => right.micros - left.micros);
  };

  return {
    totalSamples,
    totalMicros,
    wallMicros,
    functions,
    buckets: sumInto((row) => row.bucket),
    groups: sumInto((row) => row.group),
  };
}

/*
 * Contiguous stretches of samples that land in one bucket, in profile order.
 *
 * Shape distinguishes causes that a total cannot: a scheduler sleeping on a
 * 1ms timer floor produces thousands of ~1ms stretches, while a thread
 * genuinely blocked on I/O or a guest Thread.sleep produces far fewer, longer
 * ones. Same total, opposite fix.
 */
function runLengths(profile, bucketName) {
  const nodeBucket = new Map();
  for (const node of profile.nodes || []) {
    const call = node.callFrame || {};
    nodeBucket.set(node.id, classify({
      functionName: call.functionName || '(anonymous)',
      url: call.url || '',
    }).bucket);
  }
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  const runs = [];
  let current = null;
  for (let index = 0; index < samples.length; index++) {
    const matches = nodeBucket.get(samples[index]) === bucketName;
    const delta = Math.max(0, Number(deltas[index]) || 0);
    if (matches) {
      if (current) { current.micros += delta; current.samples += 1; }
      else current = {micros: delta, samples: 1};
    } else if (current) { runs.push(current); current = null; }
  }
  if (current) runs.push(current);

  const totalMicros = runs.reduce((sum, run) => sum + run.micros, 0);
  const edges = [0, 1000, 2000, 4000, 8000, 16000, 64000, Infinity];
  const histogram = [];
  for (let index = 0; index + 1 < edges.length; index++) {
    const low = edges[index];
    const high = edges[index + 1];
    const inBin = runs.filter((run) => run.micros >= low && run.micros < high);
    histogram.push({
      label: high === Infinity ? `>=${low / 1000}ms`
        : `${low / 1000}-${high / 1000}ms`,
      runs: inBin.length,
      micros: inBin.reduce((sum, run) => sum + run.micros, 0),
    });
  }
  return {
    bucket: bucketName,
    runCount: runs.length,
    totalMicros,
    meanMicros: runs.length ? totalMicros / runs.length : 0,
    histogram,
  };
}

function formatTable(entries, totalMicros, top, label) {
  const lines = [`\n${label}`];
  lines.push(`${'ms'.padStart(10)} ${'%'.padStart(6)}  name`);
  for (const entry of entries.slice(0, top)) {
    const percent = totalMicros > 0 ? entry.micros * 100 / totalMicros : 0;
    const name = entry.key !== undefined
      ? entry.key
      : `${entry.functionName}  [${shortUrl(entry.url)}]`;
    lines.push(`${(entry.micros / 1000).toFixed(0).padStart(10)} ` +
      `${percent.toFixed(2).padStart(6)}  ${name}`);
  }
  return lines.join('\n');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }

  const profile = JSON.parse(fs.readFileSync(options.profile, 'utf8'));
  const result = analyze(profile);
  if (options.runs) result.runs = runLengths(profile, options.runs);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const total = result.totalMicros;
  const out = [];
  out.push(`profile window: ${(result.wallMicros / 1e6).toFixed(1)}s wall, ` +
    `${(total / 1e6).toFixed(1)}s attributed across ` +
    `${result.totalSamples} samples`);
  out.push(formatTable(result.groups, total, 20, 'BY GROUP'));
  out.push(formatTable(result.buckets, total, 20, 'BY BUCKET'));
  if (options.bucket) {
    const rows = result.functions.filter((row) => row.bucket === options.bucket);
    out.push(formatTable(rows, total, options.top,
      `FUNCTIONS IN ${options.bucket}`));
  } else {
    out.push(formatTable(result.functions, total, options.top,
      'TOP FUNCTIONS BY SELF TIME'));
  }
  if (options.guest) {
    // One guest method can be emitted by several tiers and split across region
    // nodes and outlined loops, so a per-function table understates it badly.
    // Merge on the guest identity in the sourceURL to get the real per-method
    // share, which is what decides whether a hot loop exists to hand-optimise.
    const census = options.census ? loadCensus(options.census) : null;
    const wasmNames = census ? wasmNameIndex(census) : null;
    let wasmResolved = 0;
    let wasmUnresolved = 0;
    const byMethod = new Map();
    for (const row of result.functions) {
      if (row.group !== 'guest-compiled') continue;
      let key = shortUrl(row.url) || row.functionName;
      if (row.bucket === 'guest:wasm' && wasmNames) {
        const resolved = wasmNames.index.get(row.functionName);
        if (resolved) { key = resolved; wasmResolved += 1; }
        else wasmUnresolved += 1;
      }
      const existing = byMethod.get(key) || {key, micros: 0, pieces: 0};
      existing.micros += row.micros;
      existing.pieces += 1;
      byMethod.set(key, existing);
    }
    const ranked = [...byMethod.values()]
      .sort((left, right) => right.micros - left.micros);
    const guestTotal = ranked.reduce((sum, row) => sum + row.micros, 0);
    out.push(`\nGUEST METHODS (merged across tiers), ` +
      `${(guestTotal / 1e6).toFixed(1)}s guest-compiled total`);
    out.push(`${'ms'.padStart(9)} ${'%all'.padStart(6)} ` +
      `${'cum%'.padStart(6)}  method${census ? '   [wasm gate]' : ''}`);
    let cumulative = 0;
    for (const row of ranked.slice(0, options.top)) {
      cumulative += row.micros;
      const method = decodeURIComponent(row.key);
      out.push(`${(row.micros / 1000).toFixed(0).padStart(9)} ` +
        `${(row.micros * 100 / total).toFixed(2).padStart(6)} ` +
        `${(cumulative * 100 / total).toFixed(2).padStart(6)}  ` +
        `${method}${census ? `   ${censusVerdict(census, method)}` : ''}`);
    }
    out.push(`(${ranked.length} distinct guest methods sampled)`);
    if (census) {
      const missing = ranked.slice(0, options.top)
        .filter((row) => !censusRow(census, decodeURIComponent(row.key))).length;
      out.push(`(${census.size} methods in census; ${missing} of the top ` +
        `${Math.min(options.top, ranked.length)} never reached the wasm gate)`);
      out.push(`(wasm frames: ${wasmResolved} resolved to a method, ` +
        `${wasmUnresolved} left anonymous` +
        `${wasmNames.collisions ? `, ${wasmNames.collisions} name collisions dropped` : ''})`);
      out.push(censusSummary(ranked, census, guestTotal));
    }
  }
  if (result.runs) {
    const runs = result.runs;
    out.push(`\nCONTIGUOUS RUNS IN ${runs.bucket}`);
    out.push(`${runs.runCount} runs, ${(runs.totalMicros / 1e6).toFixed(1)}s ` +
      `total, mean ${(runs.meanMicros / 1000).toFixed(2)}ms`);
    out.push(`${'runs'.padStart(10)} ${'ms'.padStart(10)} ` +
      `${'%'.padStart(6)}  length`);
    for (const bin of runs.histogram) {
      if (!bin.runs) continue;
      const percent = runs.totalMicros > 0
        ? bin.micros * 100 / runs.totalMicros : 0;
      out.push(`${String(bin.runs).padStart(10)} ` +
        `${(bin.micros / 1000).toFixed(0).padStart(10)} ` +
        `${percent.toFixed(1).padStart(6)}  ${bin.label}`);
    }
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

if (require.main === module) main();

module.exports = {analyze, classify, generatedTier};
