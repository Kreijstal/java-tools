'use strict';

const fs = require('fs');

function usage() {
  return [
    'Usage: node scripts/analyzeFirefoxProfile.js PROFILE --start MS',
    '       (--end MS | --duration MS) [--url TEXT] [--top N] [--json]',
    '',
    'Times are the Gecko sample timestamps stored in the raw shutdown profile.',
    'Use --url when the profile contains more than one content process.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { top: 20, json: false, url: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--') && !options.profile) {
      options.profile = argument;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const name = argument.slice(2);
    if (!['start', 'end', 'duration', 'url', 'top'].includes(name)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${argument}`);
    options[name] = argv[++index];
  }

  if (options.help) return options;
  if (!options.profile) throw new Error('A raw Firefox profile is required.');
  for (const name of ['start', 'end', 'duration', 'top']) {
    if (options[name] == null) continue;
    options[name] = Number(options[name]);
    if (!Number.isFinite(options[name])) throw new Error(`Invalid --${name} value.`);
  }
  if (options.start == null) throw new Error('--start is required.');
  if (options.end == null && options.duration == null) {
    throw new Error('Either --end or --duration is required.');
  }
  if (options.end != null && options.duration != null) {
    throw new Error('Use --end or --duration, not both.');
  }
  if (options.end == null) options.end = options.start + options.duration;
  if (!(options.end > options.start)) throw new Error('The sample window must be positive.');
  if (!Number.isInteger(options.top) || options.top < 1) throw new Error('--top must be a positive integer.');
  return options;
}

function allProcesses(profile, result = []) {
  result.push(profile);
  for (const process of profile.processes || []) allProcesses(process, result);
  return result;
}

function generatedLabelCount(thread) {
  return (thread.stringTable || []).reduce(
    (count, value) => count + (typeof value === 'string' && value.startsWith('jvm$') ? 1 : 0),
    0,
  );
}

function selectThread(profile, url) {
  const candidates = [];
  for (const process of allProcesses(profile)) {
    const matchesUrl = !url || (process.pages || []).some((page) => page.url && page.url.includes(url));
    for (const thread of process.threads || []) {
      if (thread.name !== 'GeckoMain' || !thread.samples || !thread.stackTable || !thread.frameTable) continue;
      candidates.push({
        process,
        thread,
        matchesUrl,
        generatedLabels: generatedLabelCount(thread),
      });
    }
  }
  const eligible = url ? candidates.filter((candidate) => candidate.matchesUrl) : candidates;
  if (!eligible.length) throw new Error(url ? `No GeckoMain thread matched --url ${url}.` : 'No GeckoMain thread found.');
  eligible.sort((left, right) =>
    right.generatedLabels - left.generatedLabels
    || right.thread.samples.data.length - left.thread.samples.data.length);
  return eligible[0];
}

function frameLocations(thread, stackIndex) {
  const stackSchema = thread.stackTable.schema;
  const frameSchema = thread.frameTable.schema;
  const locations = [];
  while (stackIndex != null) {
    const stack = thread.stackTable.data[stackIndex];
    if (!stack) break;
    const frame = thread.frameTable.data[stack[stackSchema.frame]];
    const location = frame && thread.stringTable[frame[frameSchema.location]];
    if (location) locations.push(location);
    stackIndex = stack[stackSchema.prefix];
  }
  return locations;
}

function shortLocation(location) {
  const source = location.indexOf(' (');
  return source < 0 ? location : location.slice(0, source);
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedCounts(map, total, limit) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, samples]) => ({ name, samples, percent: samples * 100 / total }));
}

function analyze(profile, options) {
  const selected = selectThread(profile, options.url);
  const { thread, process } = selected;
  const sampleSchema = thread.samples.schema;
  const leaf = new Map();
  const guestSelf = new Map();
  const guestInclusive = new Map();
  const wasmImportOwners = new Map();
  let samples = 0;
  let namedGuestSamples = 0;
  let generatedJsSamples = 0;
  let partialWasmSamples = 0;

  for (const sample of thread.samples.data) {
    const time = sample[sampleSchema.time];
    if (time < options.start || time >= options.end) continue;
    const locations = frameLocations(thread, sample[sampleSchema.stack]);
    const leafLocation = shortLocation(locations[0] || '(idle)');
    samples++;
    increment(leaf, leafLocation);

    const guestFrames = new Set(locations
      .map(shortLocation)
      .filter((location) => location.startsWith('jvm$')));
    if (guestFrames.size) namedGuestSamples++;
    if ([...guestFrames].some((location) => !location.startsWith('jvm$wasm$'))) {
      generatedJsSamples++;
    }
    for (const location of guestFrames) increment(guestInclusive, location);
    if (leafLocation.startsWith('jvm$')) increment(guestSelf, leafLocation);

    if (leafLocation.includes('/fieldImports/') || leafLocation.includes('/arrayImports/')) {
      const owner = [...guestFrames].find((location) => location.startsWith('jvm$wasm$'));
      if (owner) {
        const kind = leafLocation.includes('/fieldImports/') ? 'field import' : 'array import';
        increment(wasmImportOwners, `${owner} — ${kind}`);
      }
    }

    if (locations.some((location) =>
      location.includes('WebAssembly.Module')
      || location.includes('(in wasm)')
      || location.includes('/fieldImports/')
      || location.includes('/arrayImports/'))) {
      partialWasmSamples++;
    }
  }
  if (!samples) throw new Error('No samples fell inside the requested window.');

  return {
    profile: options.profile,
    thread: {
      name: thread.name,
      processType: thread.processType,
      pid: thread.pid,
      tid: thread.tid,
      pages: (process.pages || []).map((page) => page.url).filter(Boolean),
      generatedLabels: selected.generatedLabels,
    },
    window: { start: options.start, end: options.end, duration: options.end - options.start },
    samples,
    paths: {
      namedGuest: {
        samples: namedGuestSamples,
        percent: namedGuestSamples * 100 / samples,
      },
      generatedJs: {
        samples: generatedJsSamples,
        percent: generatedJsSamples * 100 / samples,
      },
      partialWasm: {
        samples: partialWasmSamples,
        percent: partialWasmSamples * 100 / samples,
      },
    },
    topLeaf: sortedCounts(leaf, samples, options.top),
    guestInclusive: sortedCounts(guestInclusive, samples, options.top),
    guestSelf: sortedCounts(guestSelf, samples, options.top),
    wasmImportOwners: sortedCounts(wasmImportOwners, samples, options.top),
  };
}

function formatRows(rows) {
  if (!rows.length) return '  (none)';
  return rows.map((row) =>
    `${String(row.samples).padStart(5)}  ${row.percent.toFixed(1).padStart(5)}%  ${row.name}`).join('\n');
}

function format(result) {
  return [
    `Profile: ${result.profile}`,
    `Thread: ${result.thread.name} (${result.thread.processType}, pid ${result.thread.pid})`,
    `Window: [${result.window.start}, ${result.window.end}) ms; ${result.samples} samples`,
    `Named guest path: ${result.paths.namedGuest.samples} (${result.paths.namedGuest.percent.toFixed(1)}%)`,
    `Generated JavaScript path: ${result.paths.generatedJs.samples} (${result.paths.generatedJs.percent.toFixed(1)}%)`,
    `Partial Wasm path: ${result.paths.partialWasm.samples} (${result.paths.partialWasm.percent.toFixed(1)}%)`,
    '',
    'Top leaf frames (self samples)',
    formatRows(result.topLeaf),
    '',
    'Named guest frames (inclusive samples)',
    formatRows(result.guestInclusive),
    '',
    'Named guest frames (self samples)',
    formatRows(result.guestSelf),
    '',
    'Partial-Wasm import owners (self samples)',
    formatRows(result.wasmImportOwners),
  ].join('\n');
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const profile = JSON.parse(fs.readFileSync(options.profile, 'utf8'));
  const result = analyze(profile, options);
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${format(result)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
  }
}

module.exports = { analyze, parseArgs, selectThread };
