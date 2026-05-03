#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { analyzeClass } = require('../src/exceptionTrapAnalyzer');

function usage() {
  console.error('Usage: node scripts/analyzeExceptionTraps.js <classes-dir-or-jar-or-class> [out.json] [--class Name] [--progress]');
  process.exit(2);
}

const args = process.argv.slice(2);
const input = args.shift();
let outPath = null;
let onlyClass = null;
let progress = false;
while (args.length) {
  const arg = args.shift();
  if (arg === '--class') {
    onlyClass = args.shift();
  } else if (arg === '--progress') {
    progress = true;
  } else if (!outPath) {
    outPath = arg;
  } else {
    usage();
  }
}
if (!input) usage();

function listClasses(target) {
  const stat = fs.statSync(target);
  if (stat.isFile() && target.endsWith('.class')) {
    return [path.basename(target, '.class')];
  }
  if (stat.isDirectory()) {
    const result = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.class')) {
          result.push(path.relative(target, full).replace(/\\/g, '/').replace(/\.class$/, '').replace(/\//g, '.'));
        }
      }
    };
    walk(target);
    return result.sort();
  }

  const jar = process.env.JAR || 'jar';
  return execFileSync(jar, ['tf', target], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.endsWith('.class'))
    .map((line) => line.replace(/\.class$/, '').replace(/\//g, '.'))
    .sort();
}

const classpath = input.endsWith('.class') ? path.dirname(input) : input;
let classes = listClasses(input);
if (onlyClass) {
  classes = [onlyClass];
}
const perClass = [];
let trapLike = 0;
let handlerAthrows = 0;

for (const className of classes) {
  try {
    if (progress) {
      console.error(`analyzing ${className}`);
    }
    const findings = analyzeClass(classpath, className);
    const traps = findings.filter((finding) => finding.trapLike);
    handlerAthrows += findings.length;
    trapLike += traps.length;
    if (findings.length) {
      perClass.push({
        className,
        handlerAthrowCount: findings.length,
        trapLikeCount: traps.length,
        findings,
      });
    }
  } catch (error) {
    perClass.push({ className, error: error.message });
  }
}

const output = {
  input,
  classCount: classes.length,
  classesWithHandlerAthrows: perClass.filter((entry) => entry.handlerAthrowCount).length,
  handlerAthrowCount: handlerAthrows,
  trapLikeCount: trapLike,
  classes: perClass,
};

if (outPath) {
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
}

console.log(`classes:            ${output.classCount}`);
console.log(`classes with traps: ${output.classesWithHandlerAthrows}`);
console.log(`handler athrows:    ${output.handlerAthrowCount}`);
console.log(`trap-like athrows:  ${output.trapLikeCount}`);
if (outPath) console.log(`wrote:              ${outPath}`);

for (const entry of perClass.filter((item) => item.trapLikeCount).slice(0, 20)) {
  console.log(`${entry.className}: ${entry.trapLikeCount}/${entry.handlerAthrowCount}`);
}
