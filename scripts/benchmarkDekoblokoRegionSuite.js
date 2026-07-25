#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const classpath = path.resolve(process.argv[2] || process.env.DEKOBLOKO_CLASSES || '');
const tracePaths = process.argv.slice(3).map((item) => path.resolve(item));

if (!fs.statSync(classpath, { throwIfNoEntry: false })?.isDirectory() ||
    !tracePaths.length || tracePaths.some((item) =>
      !fs.statSync(item, { throwIfNoEntry: false })?.isFile())) {
  console.error('Usage: node scripts/benchmarkDekoblokoRegionSuite.js ' +
    '<class-directory> <trace.json> [trace.json ...]');
  process.exit(2);
}

const replayScript = path.join(__dirname, 'benchmarkDekoblokoTraceReplay.js');
const requestedIterations = Number(process.env.DEKOBLOKO_REPLAY_ITERATIONS || 0);
const targetRoundMs = Number(process.env.DEKOBLOKO_REGION_TARGET_ROUND_MS || 50);
const cases = [];

function runReplay(tracePath, environment) {
  const child = spawnSync(process.execPath, [replayScript, tracePath, classpath], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0) {
    process.stderr.write(child.stderr || child.stdout);
    process.exit(child.status || 1);
  }
  return JSON.parse(child.stdout);
}

for (const tracePath of tracePaths) {
  let selectedIterations = requestedIterations;
  if (!selectedIterations) {
    if (!Number.isFinite(targetRoundMs) || targetRoundMs <= 0) {
      throw new Error('DEKOBLOKO_REGION_TARGET_ROUND_MS must be positive');
    }
    const calibration = runReplay(tracePath, {
      DEKOBLOKO_REPLAY_ITERATIONS: '5',
      DEKOBLOKO_REPLAY_ROUNDS: '1',
      DEKOBLOKO_REPLAY_WARMUPS: '1',
    });
    const fastestNs = Math.min(...calibration.results.map((result) =>
      result.nanosecondsPerInvocation));
    selectedIterations = Math.max(20, Math.min(5000,
      Math.ceil(targetRoundMs * 1e6 / fastestNs)));
  }
  const result = runReplay(tracePath, {
    DEKOBLOKO_REPLAY_ITERATIONS: String(selectedIterations),
  });
  result.selectedIterations = selectedIterations;
  cases.push(result);
}

process.stdout.write(`${JSON.stringify({
  node: process.version,
  classpath,
  targetRoundMs: requestedIterations ? null : targetRoundMs,
  comparisons: cases.map((item) => {
    const generated = item.results.find((result) => result.name === 'generated');
    const scalar = item.results.find((result) => result.name === 'scalar');
    const structured = item.results.find((result) => result.name === 'structured');
    const fastest = [generated, scalar, structured].reduce((left, right) =>
      left.nanosecondsPerInvocation <= right.nanosecondsPerInvocation ? left : right);
    return {
      methodKey: item.trace.methodKey,
      selectedIterations: item.selectedIterations,
      fastestTier: fastest.name,
      generatedNs: generated.nanosecondsPerInvocation,
      scalarSpeedup: generated.nanosecondsPerInvocation / scalar.nanosecondsPerInvocation,
      structuredSpeedup: generated.nanosecondsPerInvocation /
        structured.nanosecondsPerInvocation,
    };
  }),
  cases,
}, null, 2)}\n`);
