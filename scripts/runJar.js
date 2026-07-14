#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { JVM } = require('../src/core/jvm');

function usage() {
  console.error('Usage: node scripts/runJar.js [--class MainClass] [--keep-temp] [--verbose] <file.jar> [args...]');
}

function parseArgs(argv) {
  let mainClass = null;
  let keepTemp = false;
  let verbose = false;
  let jarPath = null;
  const programArgs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (jarPath) {
      programArgs.push(arg);
    } else if (arg === '--') {
      if (i + 1 >= argv.length) throw new Error('-- must be followed by a jar path');
      jarPath = argv[++i];
      programArgs.push(...argv.slice(i + 1));
      break;
    } else if (arg === '--class' || arg === '-c') {
      if (i + 1 >= argv.length) throw new Error('--class requires a value');
      mainClass = argv[++i];
    } else if (arg === '--keep-temp') {
      keepTemp = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, exitCode: 0 };
    } else {
      jarPath = arg;
    }
  }

  if (!jarPath) {
    return { help: true, exitCode: 1 };
  }

  return { jarPath, mainClass, keepTemp, verbose, programArgs };
}

async function extractJar(jarPath, outputDir) {
  const zip = await JSZip.loadAsync(fs.readFileSync(jarPath));
  const extractedClasses = [];
  let manifestText = null;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const normalized = entryName.replace(/\\/g, '/');
    if (normalized.toUpperCase() === 'META-INF/MANIFEST.MF') {
      manifestText = await entry.async('string');
    }
    if (!normalized.endsWith('.class')) continue;

    const targetPath = path.join(outputDir, ...normalized.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, Buffer.from(await entry.async('uint8array')));
    extractedClasses.push(normalized);
  }

  return { extractedClasses, manifestText };
}

function readManifestMainClass(manifestText) {
  if (!manifestText) return null;
  const unfolded = [];
  for (const line of manifestText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (line.startsWith(' ') && unfolded.length) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }

  for (const line of unfolded) {
    const match = /^Main-Class:\s*(.+)\s*$/i.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

function normalizeMainClass(className) {
  return className.replace(/\.class$/i, '').replace(/\./g, '/');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(options.exitCode);
  }

  const jarPath = path.resolve(options.jarPath);
  if (!fs.existsSync(jarPath)) {
    throw new Error(`Jar not found: ${jarPath}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-jar-'));
  try {
    const { extractedClasses, manifestText } = await extractJar(jarPath, tempDir);
    const manifestMainClass = readManifestMainClass(manifestText);
    const mainClass = options.mainClass || manifestMainClass;

    if (!mainClass) {
      const sampleClasses = extractedClasses.slice(0, 10).map((name) => name.replace(/\.class$/, '')).join(', ');
      throw new Error(`No Main-Class in manifest. Pass --class <ClassName>. Classes include: ${sampleClasses}`);
    }

    const appletParameters = {};
    for (const arg of options.programArgs) {
      const eq = arg.indexOf('=');
      if (eq > 0) appletParameters[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    const jvm = new JVM({
      classpath: [tempDir],
      verbose: options.verbose,
      appletParameters: Object.keys(appletParameters).length ? appletParameters : null,
    });
    await jvm.run(normalizeMainClass(mainClass), { args: options.programArgs });
  } finally {
    if (options.keepTemp) {
      console.error(`Kept extracted jar at ${tempDir}`);
    } else {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
