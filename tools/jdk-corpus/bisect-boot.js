#!/usr/bin/env node
'use strict';
// Find a class compiled by javac-js that breaks JDK startup: starting from the
// reference image, swap in subsets of our java.base classes and run a test.
// usage: bisect-boot.js <refJdk> <ourClassesDir> <workDir> [testArgs...]
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const [refJdk, ours, work, ...testArgs] = process.argv.slice(2);
const args = testArgs.length ? testArgs : ['-Xshare:off', '-version'];
const img = path.join(work, 'jdk-bisect');
if (!fs.existsSync(img)) cp.execFileSync('cp', ['-rlL', refJdk, img]);
const base = path.join(img, 'modules', 'java.base');
const refBase = path.join(refJdk, 'modules', 'java.base');

function walk(d, out, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(d, e.name), out, r);
    else if (e.name.endsWith('.class')) out.push(r);
  }
  return out;
}
const all = walk(ours, [], '').filter((f) => f !== 'module-info.class');

function apply(set, fromOurs) {
  for (const f of set) {
    const dst = path.join(base, f);
    const src = fromOurs ? path.join(ours, f) : path.join(refBase, f);
    try { fs.unlinkSync(dst); } catch (e) { /* new class */ }
    if (fs.existsSync(src)) fs.linkSync(src, dst);
  }
}
function boots(set) {
  apply(set, true);
  const r = cp.spawnSync(path.join(img, 'bin', 'java'), args, { encoding: 'utf8', timeout: 60000 });
  apply(set, false);
  const ok = r.status === 0;
  return { ok, out: (r.stdout || '') + (r.stderr || '') };
}

// sanity
const full = boots(all);
console.log(`all ours: ${full.ok ? 'ok' : 'FAIL'} ${full.out.split('\n')[0]}`);
if (full.ok) process.exit(0);
// delta debugging: find one minimal failing class set by halving
let cand = all;
let fixedBad = []; // classes known needed
while (cand.length > 1) {
  const half = Math.ceil(cand.length / 2);
  const a = cand.slice(0, half);
  const b = cand.slice(half);
  if (!boots(fixedBad.concat(a)).ok) { cand = a; continue; }
  if (!boots(fixedBad.concat(b)).ok) { cand = b; continue; }
  // interaction: need parts of both
  fixedBad = fixedBad.concat(b);
  cand = a;
  console.log(`interaction; keeping ${b.length} classes fixed`);
}
const res = boots(fixedBad.concat(cand));
console.log(`culprit: ${cand[0]}${fixedBad.length ? ` (with ${fixedBad.length} others)` : ''}`);
console.log(res.out.split('\n').slice(0, 5).join('\n'));
