#!/usr/bin/env node
'use strict';

// Views over a jvm.js boot `.cpuprofile` (as produced by the game launcher's
// profile dump, or by `node --cpu-prof`).
//
//   node scripts/analyzeBootCpuProfile.js PROFILE buckets
//       self time by category: guest code, JIT dispatch, JIT codegen, acorn,
//       interpreter, scheduler, gc, idle.
//   node scripts/analyzeBootCpuProfile.js PROFILE guest [N]
//       time under each guest method, attributing runtime frames to the nearest
//       enclosing guest frame, with the per-method category mix.
//   node scripts/analyzeBootCpuProfile.js PROFILE tiers
//       guest time by compilation tier, and the methods stuck on weak tiers.
//   node scripts/analyzeBootCpuProfile.js PROFILE drill 'npa/b(Lffa;I)V'
//       self-time breakdown of everything under one guest method.
//   node scripts/analyzeBootCpuProfile.js PROFILE runtime [N]
//       self time per src/jit, src/core and src/instructions function.
//
// Guest frames are identified by their generated script URL, which encodes both
// the method and the tier: jvm-generated://CLASS/METHOD(DESC)?tier=TIER

const fs = require('fs');

const [, , profilePath, command = 'buckets', argument] = process.argv;
if (!profilePath) {
  console.error('usage: analyzeBootCpuProfile.js PROFILE '
    + '[buckets|guest|tiers|drill|runtime] [arg]');
  process.exit(2);
}

const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const nodesById = new Map();
for (const node of profile.nodes) nodesById.set(node.id, node);
const parentOf = new Map();
for (const node of profile.nodes) {
  for (const child of node.children || []) parentOf.set(child, node.id);
}

// Codegen lives in these modules; everything else under src/jit is the per-call
// and per-entry machinery that runs *around* generated code.
const CODEGEN = /JvmSsaBlockRenderer|StructuredWasmCompiler|WasmJit|Emitter|codegen/i;

function guestFrame(node) {
  const url = node.callFrame.url || '';
  const match = /^jvm-generated:\/\/([^?]+)\?tier=(.*)$/.exec(url);
  if (!match) return null;
  return { method: decodeURIComponent(match[1]), tier: match[2] };
}

function category(node) {
  const name = node.callFrame.functionName || '';
  const url = node.callFrame.url || '';
  if (name === '(idle)') return 'idle';
  if (name === '(garbage collector)') return 'gc';
  if (name === '(program)') return 'vm';
  if (/jvm-generated/.test(url)) return 'guest-code';
  if (/node_modules/.test(url)) return 'compile:acorn';
  if (/src\/jit\//.test(url) || /src\/analysis\//.test(url)) {
    return CODEGEN.test(url) ? 'compile:jit' : 'dispatch:jit';
  }
  if (/src\/instructions\//.test(url)) return 'interpreter';
  if (/src\/core\/jvm\.js/.test(url)) {
    return /Tick|chedul/.test(name) ? 'scheduler' : 'core:other';
  }
  if (/src\/core\//.test(url)) return 'core:other';
  if (/src\/jre\//.test(url)) return 'jre-lib';
  return 'host';
}

function nearestGuest(node) {
  let current = node;
  let hops = 0;
  while (current && hops < 512) {
    const guest = guestFrame(current);
    if (guest) return guest;
    current = nodesById.get(parentOf.get(current.id));
    hops += 1;
  }
  return null;
}

function shortUrl(url) {
  return (url || '')
    .replace(/.*\/src\//, 'src/')
    .replace(/.*node_modules\//, 'nm/')
    .replace(/^jvm-generated:\/\//, 'G:');
}

function eachSample(visit) {
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = profile.timeDeltas[index] || 0;
    const node = nodesById.get(profile.samples[index]);
    if (node) visit(node, delta);
  }
}

function totalTime() {
  let total = 0;
  for (const delta of profile.timeDeltas) total += delta || 0;
  return total;
}

function report(counts, total, limit) {
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  for (const [key, value] of limit ? rows.slice(0, limit) : rows) {
    console.log(`${(value / 1e6).toFixed(2).padStart(8)}s ${
      (100 * value / total).toFixed(1).padStart(5)}%  ${key}`);
  }
}

const total = totalTime();
console.log(`profile ${(total / 1e6).toFixed(1)}s, ${profile.samples.length} samples`);

if (command === 'buckets') {
  const counts = new Map();
  eachSample((node, delta) => {
    const key = category(node);
    counts.set(key, (counts.get(key) || 0) + delta);
  });
  report(counts, total);
} else if (command === 'guest') {
  const perMethod = new Map();
  const perMethodCategory = new Map();
  let attributed = 0;
  eachSample((node, delta) => {
    const guest = nearestGuest(node);
    if (!guest) return;
    attributed += delta;
    perMethod.set(guest.method, (perMethod.get(guest.method) || 0) + delta);
    const key = `${guest.method}||${category(node)}`;
    perMethodCategory.set(key, (perMethodCategory.get(key) || 0) + delta);
  });
  console.log(`under a guest method ${(attributed / 1e6).toFixed(1)}s (${
    (100 * attributed / total).toFixed(1)}%); the remainder is runtime that no `
    + 'guest frame encloses');
  const limit = Number(argument || 25);
  for (const [method, value] of [...perMethod].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    const mix = [];
    for (const bucket of ['guest-code', 'dispatch:jit', 'compile:jit', 'core:other',
      'scheduler', 'interpreter', 'compile:acorn', 'gc', 'host']) {
      const part = perMethodCategory.get(`${method}||${bucket}`);
      if (part) mix.push(`${bucket} ${(100 * part / value).toFixed(0)}%`);
    }
    console.log(`${(value / 1e6).toFixed(2).padStart(8)}s ${
      (100 * value / total).toFixed(1).padStart(5)}%  ${method}   [${mix.join(' ')}]`);
  }
} else if (command === 'tiers') {
  const perTier = new Map();
  const perMethodTier = new Map();
  let attributed = 0;
  eachSample((node, delta) => {
    const guest = nearestGuest(node);
    if (!guest) return;
    attributed += delta;
    perTier.set(guest.tier, (perTier.get(guest.tier) || 0) + delta);
    const key = `${guest.method}|${guest.tier}`;
    perMethodTier.set(key, (perMethodTier.get(key) || 0) + delta);
  });
  console.log(`guest-attributed ${(attributed / 1e6).toFixed(1)}s by tier:`);
  report(perTier, attributed);
  console.log('\nlargest methods stuck on a weak tier:');
  const weak = [...perMethodTier]
    .filter(([key]) => /generated-sync|positional-entry|interpreter/.test(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, Number(argument || 15));
  for (const [key, value] of weak) {
    console.log(`${(value / 1e6).toFixed(2).padStart(8)}s  ${key}`);
  }
} else if (command === 'drill') {
  if (!argument) {
    console.error('drill needs a guest method, e.g. \'npa/b(Lffa;I)V\'');
    process.exit(2);
  }
  const counts = new Map();
  const tiers = new Map();
  let under = 0;
  eachSample((node, delta) => {
    const guest = nearestGuest(node);
    if (!guest || guest.method !== argument) return;
    under += delta;
    tiers.set(guest.tier, (tiers.get(guest.tier) || 0) + delta);
    const key = `${node.callFrame.functionName || '(anon)'}  ${shortUrl(node.callFrame.url)}`;
    counts.set(key, (counts.get(key) || 0) + delta);
  });
  if (!under) {
    console.log(`no samples under ${argument}`);
    process.exit(0);
  }
  console.log(`\n${argument}: ${(under / 1e6).toFixed(2)}s`);
  console.log('tiers: ' + [...tiers].sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key} ${(value / 1e6).toFixed(2)}s`).join('  '));
  report(counts, under, 20);
} else if (command === 'runtime') {
  const counts = new Map();
  eachSample((node, delta) => {
    const url = node.callFrame.url || '';
    if (!/src\/(jit|core|instructions)\//.test(url)) return;
    const key = `${node.callFrame.functionName || '(anon)'}  ${shortUrl(url)}`;
    counts.set(key, (counts.get(key) || 0) + delta);
  });
  report(counts, total, Number(argument || 25));
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
