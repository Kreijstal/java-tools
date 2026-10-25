'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {runDetailed} = require('../test/helpers/closedWorld');

const wasmHeapMb = Number(process.argv[2] || 1), forks = Number(process.argv[3] || 1);
if (![1, 4].includes(wasmHeapMb) || !Number.isInteger(forks) || forks < 1 || forks > 10)
  throw new Error('Usage: node benchmarks/run-closed-spill-access.js [1|4] [forks=1]');
const root = path.join(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-spill-access-'));
try {
  cp.execFileSync('javac', ['--release', '8', '-d', directory, path.join(__dirname, 'ClosedSpillAccess.java')]);
  const sourceCommit = cp.execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  const dirtyRuntime = cp.spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'src'], {cwd: root}).status !== 0;
  for (let fork = 0; fork < forks; fork++) {
    const result = runDetailed(directory, 'ClosedSpillAccess', {
      closedWorld: true, wasmHeapMb, jit: {compileWorker: false},
    });
    if (result.failure) throw new Error(result.stderr);
    const loopNs = Number(result.output.match(/loopNs=(\d+)/)?.[1]);
    if (!Number.isFinite(loopNs) || !result.stats?.built || !(result.stats.entries > 0))
      throw new Error('Missing closed-world benchmark result');
    console.log(JSON.stringify({sourceCommit, dirtyRuntime, host: os.hostname(), node: process.version,
      wasmHeapMb, fork, loopMs: loopNs / 1e6, spilledObjects: result.stats.spilledObjects,
      checksum: result.output.trim().replace(/^loopNs=\d+ /, '')}));
  }
} finally {fs.rmSync(directory, {recursive: true, force: true});}
