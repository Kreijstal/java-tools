#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const benchmark = path.join(
  root, 'scripts', 'benchmarkSsaHandwrittenKernelTargets.js');
const limits = new Map([
  ['tiled-blit', 0.70],
  ['tiled-blit-compiled-caller', 1.00],
  ['perspective-span', 0.55],
  ['bilinear-sampler', 0.35],
  ['polygon-span', 1.12],
  ['polygon-raster', 1.15],
  ['polygon-edge-table', 1.12],
]);

const output = execFileSync(process.execPath, [benchmark], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    SSA_KERNEL_TARGET_ITERATIONS:
      process.env.SSA_KERNEL_TARGET_ITERATIONS || '10000',
    SSA_KERNEL_TARGET_ROUNDS:
      process.env.SSA_KERNEL_TARGET_ROUNDS || '5',
    SSA_KERNEL_TARGET_WARMUPS:
      process.env.SSA_KERNEL_TARGET_WARMUPS || '4',
  },
});
const report = JSON.parse(output);
const failures = [];
const seen = new Set();

if (report.ok !== true) failures.push('benchmark did not report ok=true');
for (const result of report.results || []) {
  const limit = limits.get(result.name);
  if (limit === undefined) {
    failures.push(`unexpected target ${result.name}`);
    continue;
  }
  seen.add(result.name);
  if (!result.timingQualified) {
    failures.push(`${result.name}: timing sample was not qualified`);
  }
  if (result.checksum !== result.oracleChecksum) {
    failures.push(`${result.name}: checksum mismatch ` +
      `${result.checksum} != ${result.oracleChecksum}`);
  }
  if (!Number.isFinite(result.medianPairedRatio) ||
      result.medianPairedRatio > limit) {
    failures.push(`${result.name}: generic/oracle ratio ` +
      `${Number(result.medianPairedRatio).toFixed(3)} > ${limit.toFixed(2)}`);
  }
  process.stdout.write(`${result.name}: ` +
    `${result.medianPairedRatio.toFixed(3)} <= ${limit.toFixed(2)} ` +
    `(checksum ${result.checksum === result.oracleChecksum ? 'match' : 'MISMATCH'})\n`);
}
for (const name of limits.keys()) {
  if (!seen.has(name)) failures.push(`missing target ${name}`);
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('fast generic-kernel performance gate passed\n');
}
