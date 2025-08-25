#!/usr/bin/env node
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');

async function listStrings(classPath) {
  try {
    console.log(`Initializing workspace for path: ${classPath}`);
    const workspace = await KrakatauWorkspace.create(classPath);

    console.log('Finding all UTF-8 strings...');
    const utf8Strings = workspace.listUtf8Strings();

    if (utf8Strings.length === 0) {
      console.log('No UTF-8 strings found.');
      return;
    }

    console.log('Found strings:');
    for (const str of utf8Strings) {
      console.log(`- ${str}`);
    }

  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/listAllStrings.js <classPath>');
    process.exit(1);
  }

  const classPath = args[0];
  listStrings(classPath);
}

main();
