#!/usr/bin/env node
'use strict';

// Views over a HotSpot JFR recording of a game boot, as produced by
// `scripts/run-jre-reflection-main-menu.js --game NAME --jfr-profile OUT.jfr`
// (from the dekobloko work tree).
//
//   node scripts/analyzeJreLoadingProfile.js RECORDING.jfr timeline [BUCKET_S]
//       samples per time bucket, with the dominant method in each. Use this
//       FIRST: it shows where loading ends and the render loop begins.
//   node scripts/analyzeJreLoadingProfile.js RECORDING.jfr hot [UNTIL_S]
//       hottest methods by self time, restricted to the first UNTIL_S seconds.
//
// Reading a boot recording whole is misleading: the post-menu render loop runs
// at ~95% CPU and swamps a loading phase that runs at ~10%, so an unrestricted
// hot list reports the renderer as the boot's hot method. Always bucket first,
// then restrict to the loading window.
//
// Requires the `jfr` tool from the JDK on PATH.

const { execFileSync } = require('child_process');

const [, , recording, command = 'timeline', argument] = process.argv;
if (!recording) {
  console.error('usage: analyzeJreLoadingProfile.js RECORDING.jfr '
    + '[timeline|hot] [seconds]');
  process.exit(2);
}

let raw;
try {
  raw = execFileSync('jfr', ['print', '--json', '--events', 'jdk.ExecutionSample',
    recording], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
} catch (error) {
  console.error(`could not run jfr on ${recording}: ${error.message}`);
  process.exit(1);
}

const events = JSON.parse(raw).recording.events;
if (!events.length) {
  console.error('recording contains no jdk.ExecutionSample events; was it '
    + 'started with settings=profile?');
  process.exit(1);
}

// JFR's default profile sampling interval. Only used to turn a sample count
// into an approximate CPU time, which is the number worth comparing.
const SAMPLE_MS = 20;
const origin = new Date(events[0].values.startTime).getTime();

function frameKey(frame) {
  return `${frame.method.type.name.replace(/\//g, '.')}.${frame.method.name}${
    frame.method.descriptor}`;
}

function secondsOf(event) {
  return (new Date(event.values.startTime).getTime() - origin) / 1000;
}

if (command === 'timeline') {
  const bucketSeconds = Number(argument || 2);
  const buckets = [];
  for (const event of events) {
    const index = Math.floor(secondsOf(event) / bucketSeconds);
    if (!buckets[index]) buckets[index] = { count: 0, top: new Map() };
    buckets[index].count += 1;
    const frames = event.values.stackTrace.frames;
    if (!frames.length) continue;
    const key = frameKey(frames[0]);
    buckets[index].top.set(key, (buckets[index].top.get(key) || 0) + 1);
  }
  const perBucket = (bucketSeconds * 1000) / SAMPLE_MS;
  console.log('t(s)  samples   ~cpu%  dominant self-time methods');
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    const at = String(index * bucketSeconds).padStart(4);
    if (!bucket) {
      console.log(`${at}s        0     0%`);
      continue;
    }
    const dominant = [...bucket.top].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([key, value]) => `${key.replace(/\(.*/, '')} ${value}`).join('  ');
    console.log(`${at}s ${String(bucket.count).padStart(7)} ${
      (100 * bucket.count / perBucket).toFixed(0).padStart(6)}%  ${dominant}`);
  }
} else if (command === 'hot') {
  const until = argument === undefined ? Infinity : Number(argument);
  const self = new Map();
  const threads = new Map();
  let counted = 0;
  for (const event of events) {
    if (secondsOf(event) > until) continue;
    counted += 1;
    const thread = event.values.sampledThread.javaName;
    threads.set(thread, (threads.get(thread) || 0) + 1);
    const frames = event.values.stackTrace.frames;
    if (!frames.length) continue;
    const key = frameKey(frames[0]);
    self.set(key, (self.get(key) || 0) + 1);
  }
  const window = until === Infinity ? 'whole recording' : `0..${until}s`;
  console.log(`${window}: ${counted} samples ~= ${
    (counted * SAMPLE_MS / 1000).toFixed(2)}s of CPU across all threads`);
  console.log('\nper thread:');
  for (const [name, count] of [...threads].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(5)}  ${name}`);
  }
  console.log('\nself time:');
  for (const [key, count] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`${String(count).padStart(5)} ${
      (count * SAMPLE_MS / 1000).toFixed(2).padStart(7)}s  ${key}`);
  }
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
