#!/usr/bin/env node
'use strict';
// Long-running differential wall-time attribution for dekobloko in Firefox.
//
// Per-call timing probes proved unreliable (they inflated a ~5% block to a
// claimed 29% of frame time), so this harness attributes cost the honest way:
// it repeatedly measures whole-app fps with exactly one feature disabled per
// run and accumulates per-configuration medians until the deltas separate
// from run-to-run noise (single-run spread is up to ~1.4 fps).
//
// Usage:
//   node scripts/attributeDekoblokoWallTime.js [--minutes 180] [--runs N]
//
// Requirements: the dekobloko page server on 127.0.0.1:3765 and a deployed
// bundle at /tmp/dekobloko-browser-bundle/jvm-debug-current.js.
//
// Output (continuously updated):
//   /tmp/dekobloko-attribution-runs.jsonl  — one line per run
//   /tmp/dekobloko-attribution-summary.json — per-config stats + deltas
//   /tmp/dekobloko-attribution-summary.md   — human-readable table

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNS_PATH = '/tmp/dekobloko-attribution-runs.jsonl';
const SUMMARY_JSON = '/tmp/dekobloko-attribution-summary.json';
const SUMMARY_MD = '/tmp/dekobloko-attribution-summary.md';
const ACCEPTED_FIRST_HASHES = new Set([4025147891, 4136367231]);

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined
    ? Number(args[index + 1]) : fallback;
};
const maxMinutes = argValue('--minutes', 180);
const maxRuns = argValue('--runs', Infinity);

// Each configuration disables exactly one feature relative to the baseline.
// The fps *delta* vs baseline is the honest cost of what that feature buys.
// PROBE_RENDERER_PIPELINE=0 (everything off) is deliberately absent: the game
// then animates too slowly to complete the probe's animation window, so every
// run comes back invalid.
const CONFIGS = [
  { name: 'baseline', env: {} },
  { name: 'no-handwritten-gradient', env: { PROBE_HANDWRITTEN_FUSED: '0' } },
  { name: 'no-fused-regions', env: { PROBE_FUSED_REGIONS: '0' } },
  { name: 'no-structured-ssa', env: { PROBE_STRUCTURED_SSA: '0' } },
  { name: 'no-scalar-loops', env: { PROBE_SCALAR_LOOPS: '0' } },
  { name: 'no-wasm-jit', env: { PROBE_WASM_JIT: '0' } },
  { name: 'no-wasm-field-cache', env: { PROBE_WASM_FIELD_CACHE: '0' } },
];

function firefoxExecutable() {
  const cache = path.join(process.env.HOME || '', '.cache/ms-playwright');
  const entries = fs.readdirSync(cache)
    .filter((name) => name.startsWith('firefox-'))
    .sort();
  for (const entry of entries.reverse()) {
    const candidate = path.join(cache, entry, 'firefox/firefox');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no Playwright Firefox found');
}

function runOnce(config, executablePath) {
  const result = spawnSync('node', ['scripts/profileDekoblokoFirefox.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PROBE_RENDERER_PIPELINE: '1',
      FIREFOX_EXECUTABLE_PATH: executablePath,
      ...config.env,
    },
    encoding: 'utf8',
    timeout: 8 * 60 * 1000,
  });
  const raw = `${result.stdout || ''}`;
  const jsonStart = raw.indexOf('{');
  const record = {
    at: new Date().toISOString(),
    config: config.name,
    ok: false,
    fps: null,
    firstHash: null,
    reason: null,
  };
  if (result.error) {
    record.reason = `spawn: ${result.error.message}`;
    return record;
  }
  if (jsonStart < 0) {
    record.reason = `no JSON output (status ${result.status}): ` +
      `${raw.slice(0, 200)}${(result.stderr || '').slice(0, 200)}`;
    return record;
  }
  let data;
  try {
    data = JSON.parse(raw.slice(jsonStart));
  } catch (error) {
    record.reason = `parse: ${error.message}`;
    return record;
  }
  const animation = data.animation;
  record.fps = animation?.changedFramesPerSecond ?? null;
  record.firstHash = animation?.firstHash ?? null;
  const pageErrors = (data.pageErrors || []).length;
  const consoleErrors = (data.consoleErrors || []).length;
  if (record.fps === null) record.reason = 'no animation phase';
  else if (!ACCEPTED_FIRST_HASHES.has(record.firstHash)) {
    record.reason = `unexpected first hash ${record.firstHash}`;
  } else if (pageErrors || consoleErrors) {
    record.reason = `errors page=${pageErrors} console=${consoleErrors}`;
  } else record.ok = true;
  return record;
}

function loadRuns() {
  if (!fs.existsSync(RUNS_PATH)) return [];
  return fs.readFileSync(RUNS_PATH, 'utf8').split('\n')
    .filter(Boolean).map((line) => JSON.parse(line));
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(runs) {
  const byConfig = new Map(CONFIGS.map((config) => [config.name, []]));
  for (const run of runs) {
    if (run.ok && byConfig.has(run.config)) byConfig.get(run.config).push(run.fps);
  }
  const stats = {};
  for (const [name, values] of byConfig) {
    const sorted = [...values].sort((a, b) => a - b);
    stats[name] = {
      n: sorted.length,
      median: quantile(sorted, 0.5),
      q25: quantile(sorted, 0.25),
      q75: quantile(sorted, 0.75),
      min: sorted[0] ?? null,
      max: sorted[sorted.length - 1] ?? null,
    };
  }
  const base = stats.baseline;
  for (const [name, entry] of Object.entries(stats)) {
    if (name === 'baseline' || entry.median === null || !base?.median) continue;
    entry.deltaVsBaseline = entry.median - base.median;
    // deltas whose interquartile ranges do not overlap the baseline's are
    // separated from noise; overlapping ones are still indistinguishable
    entry.separated = entry.q75 < base.q25 || entry.q25 > base.q75;
  }
  const invalid = runs.filter((run) => !run.ok).length;
  return { updatedAt: new Date().toISOString(), totalRuns: runs.length,
    invalidRuns: invalid, stats };
}

function writeSummary(summary) {
  fs.writeFileSync(SUMMARY_JSON, JSON.stringify(summary, null, 2));
  const lines = [
    '# Dekobloko differential wall-time attribution',
    '',
    `Updated: ${summary.updatedAt} — ${summary.totalRuns} runs ` +
      `(${summary.invalidRuns} invalid)`,
    '',
    '| config | n | median fps | IQR | delta vs baseline | separated from noise |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const [name, s] of Object.entries(summary.stats)) {
    const iqr = s.q25 !== null ? `${s.q25.toFixed(2)}–${s.q75.toFixed(2)}` : '—';
    const delta = s.deltaVsBaseline !== undefined
      ? `${s.deltaVsBaseline >= 0 ? '+' : ''}${s.deltaVsBaseline.toFixed(2)}` : '—';
    const separated = s.separated === undefined ? '—' : s.separated ? 'YES' : 'no';
    lines.push(`| ${name} | ${s.n} | ${s.median !== null ? s.median.toFixed(2) : '—'} ` +
      `| ${iqr} | ${delta} | ${separated} |`);
  }
  lines.push('', 'A negative delta = the disabled feature was buying that much fps',
    '(its honest wall-time share). Deltas within the noise band mean the',
    'feature\'s whole-app contribution is smaller than run-to-run variance.');
  fs.writeFileSync(SUMMARY_MD, `${lines.join('\n')}\n`);
}

function shuffled(items, seed) {
  const array = [...items];
  let state = seed >>> 0;
  for (let index = array.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const pick = state % (index + 1);
    [array[index], array[pick]] = [array[pick], array[index]];
  }
  return array;
}

async function main() {
  const executablePath = firefoxExecutable();
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  let runCount = loadRuns().length;
  let cycle = 0;
  console.log(`attribution loop: ${CONFIGS.length} configs, ` +
    `until ${new Date(deadline).toISOString()} or ${maxRuns} runs; ` +
    `resuming with ${runCount} existing runs`);
  while (Date.now() < deadline && runCount < maxRuns) {
    cycle += 1;
    // shuffled order each cycle decorrelates system drift from config identity
    for (const config of shuffled(CONFIGS, cycle * 2654435761)) {
      if (Date.now() >= deadline || runCount >= maxRuns) break;
      const record = runOnce(config, executablePath);
      fs.appendFileSync(RUNS_PATH, `${JSON.stringify(record)}\n`);
      runCount += 1;
      const summary = summarize(loadRuns());
      writeSummary(summary);
      console.log(`[cycle ${cycle}] ${config.name}: ` +
        `${record.ok ? `${record.fps.toFixed(2)} fps` : `INVALID (${record.reason})`}`);
    }
  }
  console.log(`done after ${runCount} runs; summary at ${SUMMARY_MD}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
