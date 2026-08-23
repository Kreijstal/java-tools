#!/usr/bin/env node

/**
 * Generate sample data for the JVM Debug Interface GitHub Pages site.
 *
 * The browser toolchain compiles Java itself, so instead of shipping
 * pre-compiled classes in a data.zip we ship the .java sources plus a
 * manifest. The browser fetches the manifest at boot (tiny), populates the
 * sample picker from it, and lazily fetches + compiles a sample's source
 * (and its cross-file dependency closure) the first time it is selected.
 */

const fs = require('fs');
const path = require('path');
const frontend = require('../src/java-frontend');
const { createCompileProgressReporter } = require('./compile-progress');

console.log('🔧 Generating sample data for the JVM Debug Interface...');

const rootDir = process.cwd();
const sourcesDir = path.join(rootDir, 'sources');
const distDir = path.join(rootDir, 'dist');
const dataDir = path.join(distDir, 'data');

const sourceFiles = fs.readdirSync(sourcesDir)
  .filter((file) => file.endsWith('.java'))
  .sort();

// Compile everything with the repository frontend (the same compiler that
// ships in the browser bundle). Class files land next to their sources so the
// Node test fixtures stay available; the compile result drives the manifest.
console.log(`📁 Compiling ${sourceFiles.length} Java sources with the JS frontend...`);
const result = frontend.compileJavaFiles(
  sourceFiles.map((file) => path.join(sourcesDir, file)),
  {
    outputDir: sourcesDir,
    // Whole-corpus compiles are long enough that a silent run is
    // indistinguishable from a hung one; report each file as it lands.
    onProgress: createCompileProgressReporter(),
  },
);

// Group emitted classes by the source file they came from.
const classesBySource = new Map(sourceFiles.map((file) => [file, []]));
const definingSource = new Map(); // internalName -> source file
for (const classEntry of result.classes) {
  const source = classEntry.sourceFile;
  if (!classesBySource.has(source)) classesBySource.set(source, []);
  classesBySource.get(source).push(classEntry);
  definingSource.set(classEntry.internalName, source);
}

function referencedInternalNames(jasmin) {
  const refs = new Set();
  for (const match of jasmin.matchAll(/\b(?:Field|Method|InterfaceMethod)\s+(\S+)\s/g)) refs.add(match[1]);
  for (const match of jasmin.matchAll(/\b(?:new|checkcast|instanceof|anewarray)\s+(\S+)/g)) refs.add(match[1]);
  for (const match of jasmin.matchAll(/^\s*\.super\s+(\S+)/gm)) refs.add(match[1]);
  for (const match of jasmin.matchAll(/^\s*\.implements\s+(\S+)/gm)) refs.add(match[1]);
  return refs;
}

// Direct cross-file dependencies: source -> Set<source>.
const directDeps = new Map();
for (const [source, classes] of classesBySource) {
  const own = new Set(classes.map((classEntry) => classEntry.internalName));
  const deps = new Set();
  for (const classEntry of classes) {
    for (const ref of referencedInternalNames(classEntry.jasmin)) {
      const provider = definingSource.get(ref);
      if (provider && provider !== source && !own.has(ref)) deps.add(provider);
    }
  }
  directDeps.set(source, deps);
}

function dependencyClosure(source) {
  const closure = new Set();
  const queue = [...(directDeps.get(source) || [])];
  while (queue.length) {
    const dep = queue.pop();
    if (closure.has(dep)) continue;
    closure.add(dep);
    for (const transitive of directDeps.get(dep) || []) queue.push(transitive);
  }
  return [...closure].sort();
}

function superClassOf(jasmin) {
  const match = jasmin.match(/^\s*\.super\s+(\S+)/m);
  return match ? match[1] : null;
}

const jasminByInternalName = new Map(
  result.classes.map((classEntry) => [classEntry.internalName, classEntry.jasmin]),
);

function launchModeOf(classEntry) {
  // Same semantics as BrowserJVMDebug.getClassLaunchInfo, evaluated at build
  // time: applet if the superclass chain reaches java/applet/Applet, else
  // application if there is a public static main(String[]).
  const visited = new Set();
  let current = classEntry.internalName;
  while (current && !visited.has(current)) {
    visited.add(current);
    const jasmin = jasminByInternalName.get(current);
    if (!jasmin) break;
    const superName = superClassOf(jasmin);
    if (superName === 'java/applet/Applet') return 'applet';
    if (!superName || superName === 'java/lang/Object') break;
    current = superName;
  }
  const mainMatch = classEntry.jasmin.match(
    /^\s*\.method\s+([\w $]*)\bmain\b\s*:\s*\(\[Ljava\/lang\/String;\)V/m,
  );
  if (mainMatch && /\bpublic\b/.test(mainMatch[1]) && /\bstatic\b/.test(mainMatch[1])) {
    return 'application';
  }
  return null;
}

const samples = sourceFiles.map((source) => {
  const classes = (classesBySource.get(source) || [])
    .slice()
    .sort((left, right) => left.internalName.localeCompare(right.internalName));
  const runnable = classes
    .map((classEntry) => ({ classEntry, launchMode: launchModeOf(classEntry) }))
    .filter((entry) => entry.launchMode)
    .map((entry) => ({
      classPath: `${entry.classEntry.internalName}.class`,
      launchMode: entry.launchMode,
    }));
  return {
    source,
    classes: classes.map((classEntry) => classEntry.internalName),
    runnable,
    dependsOn: dependencyClosure(source),
  };
});

// Reset dist/data and write sources + manifest. Also drop the retired
// data.zip artifacts so stale copies cannot be served or shipped.
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(path.join(distDir, 'data.zip'), { force: true });
fs.rmSync(path.join(rootDir, 'examples', 'data.zip'), { force: true });
fs.mkdirSync(dataDir, { recursive: true });

console.log('📄 Copying sample sources...');
for (const source of sourceFiles) {
  fs.copyFileSync(path.join(sourcesDir, source), path.join(dataDir, source));
}

const manifest = {
  generated: new Date().toISOString(),
  totalSources: samples.length,
  totalClasses: result.classes.length,
  samples,
};
fs.writeFileSync(
  path.join(dataDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
);

const runnableCount = samples.reduce((sum, sample) => sum + sample.runnable.length, 0);
console.log(`✅ Wrote ${sourceFiles.length} sources + manifest.json to dist/data`);
console.log(`📊 ${result.classes.length} classes, ${runnableCount} runnable samples`);
