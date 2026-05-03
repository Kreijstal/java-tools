#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const { analyzeRenameSafety } = require('../src/renameSafetyAnalyzer');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node scripts/analyzeRenameSafety.js <classPath> [outputFile] [--main-class <className>]');
    process.exit(1);
  }

  const classPath = args[0];
  let outputFile = null;
  let mainClass = null;

  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--main-class') {
      mainClass = args[++i];
    } else if (!outputFile) {
      outputFile = args[i];
    } else {
      console.error(`Unexpected argument: ${args[i]}`);
      process.exit(1);
    }
  }

  const workspace = await KrakatauWorkspace.create(classPath);
  const result = analyzeRenameSafety(workspace, { mainClass });
  const text = `${JSON.stringify(result, null, 2)}\n`;

  if (outputFile) {
    fs.writeFileSync(outputFile, text);
    console.log(`Rename safety report written to ${outputFile}`);
  } else {
    process.stdout.write(text);
  }
}

main().catch((error) => {
  console.error('Failed to analyze rename safety:', error);
  process.exit(1);
});
