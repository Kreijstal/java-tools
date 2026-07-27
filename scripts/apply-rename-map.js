#!/usr/bin/env node
'use strict';

const { applyRenameMapFile } = require('../src/workspace/applyRenameMap');

function usage() {
  process.stderr.write(
    'Usage: node scripts/apply-rename-map.js [--force] [--profile] <classes-dir> <mapping.json> <output-dir>\n',
  );
}

async function main(argv = process.argv.slice(2)) {
  const force = argv.includes('--force');
  const profile = argv.includes('--profile');
  const positional = argv.filter((arg) => arg !== '--force' && arg !== '--profile');
  if (positional.length !== 3) {
    usage();
    return 2;
  }
  const [inputDir, mapFile, outputDir] = positional;
  try {
    const result = await applyRenameMapFile(inputDir, mapFile, outputDir, { force, profile });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main };
