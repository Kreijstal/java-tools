'use strict';

/**
 * A resumable build cache for `compileJavaFiles`, in the spirit of make: a
 * source whose class files are already on disk and still current is not
 * compiled again.
 *
 * What "still current" means here is deliberately coarse. A source's output
 * depends on every sibling source, not just itself - sibling declarations
 * decide overload resolution, inherited members, and which simple name wins -
 * so the cache is keyed on a fingerprint of the whole source tree rather than
 * on one file's mtime. Change any input and the whole batch recompiles. That
 * is enough for the case this exists for: a batch that was interrupted resumes
 * where it stopped, and a batch with nothing to do does nothing.
 *
 * The fingerprint also covers the compiler's own sources. Editing an emitter
 * and then reusing class files built by the previous emitter would hand back
 * output that no longer matches the compiler that claims to have produced it.
 */

const hostFs = require('fs');
const hostPath = require('path');

// Cached Jasmin text is bulky - on a decompiled game corpus it runs six times
// the size of the class files it describes - and it compresses about eightfold
// at level 1 for a few hundred microseconds per file. zlib is absent from the
// browser bundle (webpack.config.js), so its absence is a supported case, not
// an error.
let zlib = null;
try {
  const candidate = require('zlib');
  if (candidate && typeof candidate.gzipSync === 'function' && typeof candidate.gunzipSync === 'function') {
    zlib = candidate;
  }
} catch (_) {
  zlib = null;
}

const CACHE_DIRECTORY_NAME = '.java-frontend-build';
const CACHE_FORMAT = 3;

/**
 * 64-bit FNV-1a-style digest, as two 32-bit lanes. Not cryptographic: it exists
 * to notice edits, and `crypto` is unavailable in the browser bundle
 * (webpack.config.js maps it to false).
 * @param {string} text
 * @returns {string} - 16 hex characters
 */
function digest(text) {
  let low = 0x811c9dc5;
  let high = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193);
    high = Math.imul(high ^ code, 0x85ebca6b);
    high ^= high >>> 13;
  }
  return `${(low >>> 0).toString(16).padStart(8, '0')}${(high >>> 0).toString(16).padStart(8, '0')}`;
}

function collectFiles(fileSystem, pathModule, directory, extension, out = []) {
  let entries = [];
  try {
    entries = fileSystem.readdirSync(directory, { withFileTypes: true });
  } catch (_) {
    // A source root that does not exist yet contributes nothing rather than
    // failing the build; the compile itself will report a missing input.
    return out;
  }
  for (const entry of entries) {
    const full = pathModule.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(fileSystem, pathModule, full, extension, out);
    else if (entry.isFile() && entry.name.endsWith(extension)) out.push(full);
  }
  return out;
}

function packageVersion() {
  try {
    // Bundled too, so it is the only compiler-identity signal a browser build
    // has. It moves per release, not per edit.
    return String(require('../../package.json').version || '');
  } catch (_) {
    return '';
  }
}

/**
 * Digest of the compiler's own modules, so a cache never survives a change to
 * the code that produced it. In a browser bundle the sources are not on any
 * filesystem to stat, and this degrades to the package version - a cache there
 * has to be cleared by hand after the bundle is rebuilt.
 */
function compilerFingerprint() {
  const directories = [
    __dirname,
    hostPath.join(__dirname, '..', 'utils'),
    hostPath.join(__dirname, '..', 'parsing'),
  ];
  const parts = [];
  for (const directory of directories) {
    let entries = [];
    try {
      entries = hostFs.readdirSync(directory, { withFileTypes: true });
    } catch (_) {
      return 'bundled';
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const full = hostPath.join(directory, entry.name);
      const stats = hostFs.statSync(full);
      parts.push(`${full}:${stats.size}:${stats.mtimeMs}`);
    }
  }
  return digest(parts.join('\n'));
}

/**
 * Everything outside a single source file that can change its class files.
 */
function batchFingerprint(options, sourceRoot) {
  const fileSystem = options.fileSystem || options.fs || hostFs;
  const pathModule = options.pathModule || hostPath;
  const parts = [
    `format=${CACHE_FORMAT}`,
    `version=${packageVersion()}`,
    `compiler=${compilerFingerprint()}`,
    `sourceLevel=${options.sourceLevel || ''}`,
    `sourceRoot=${sourceRoot}`,
    `outputDir=${options.outputDir}`,
    `assembler=${process.env.JAVA_FRONTEND_ASSEMBLER || ''}`,
    `assembly=${JSON.stringify(options.assembly || {})}`,
  ];
  // Every sibling source, not just the batch inputs: resolution reads the
  // source root off the filesystem, so a file that is not being compiled can
  // still decide what the files being compiled emit.
  for (const file of collectFiles(fileSystem, pathModule, sourceRoot, '.java').sort()) {
    let content = '';
    try {
      content = String(fileSystem.readFileSync(file, 'utf8'));
    } catch (_) {
      content = '<unreadable>';
    }
    parts.push(`src=${file}:${digest(content)}`);
  }
  // Classpath metadata comes from class files, which are stat-checked rather
  // than read: a classpath can be an entire JRE.
  const classpath = Array.isArray(options.classpath)
    ? options.classpath
    : [options.classpath].filter(Boolean);
  for (const root of classpath) {
    const resolved = pathModule.resolve(root);
    parts.push(`cp=${resolved}`);
    for (const file of collectFiles(fileSystem, pathModule, resolved, '.class').sort()) {
      let stamp = 'missing';
      try {
        const stats = fileSystem.statSync(file);
        stamp = `${stats.size}:${stats.mtimeMs}`;
      } catch (_) {
        stamp = 'unreadable';
      }
      parts.push(`cpfile=${file}:${stamp}`);
    }
  }
  return digest(parts.join('\n'));
}

class BuildCache {
  constructor(settings, options, sourceRoot) {
    this.fileSystem = options.fileSystem || options.fs || hostFs;
    this.pathModule = options.pathModule || hostPath;
    this.force = Boolean(settings.force);
    this.directory = settings.cacheDir
      || this.pathModule.join(options.outputDir, CACHE_DIRECTORY_NAME);
    this.fingerprint = batchFingerprint(options, sourceRoot);
    this.entries = new Map();
  }

  entryPath(inputPath, compressed = Boolean(zlib)) {
    return this.pathModule.join(
      this.directory,
      `${digest(inputPath)}.json${compressed ? '.gz' : ''}`,
    );
  }

  readEntryText(inputPath) {
    if (zlib) {
      try {
        return String(zlib.gunzipSync(this.fileSystem.readFileSync(this.entryPath(inputPath, true))));
      } catch (_) {
        // Fall through: a cache written by a build without zlib is still valid.
      }
    }
    return String(this.fileSystem.readFileSync(this.entryPath(inputPath, false), 'utf8'));
  }

  /**
   * The cached build of `inputPath`, or null when it is missing, stale, or its
   * class files no longer match what was recorded.
   * @param {string} inputPath
   * @returns {object|null}
   */
  read(inputPath) {
    if (this.force) return null;
    if (this.entries.has(inputPath)) return this.entries.get(inputPath);
    let entry = null;
    try {
      entry = JSON.parse(this.readEntryText(inputPath));
    } catch (_) {
      // No entry, or one written by a different version. Either way: compile.
      this.entries.set(inputPath, null);
      return null;
    }
    // The file name is a digest of the input path, so confirm the entry really
    // describes this input before trusting it.
    if (!entry || entry.format !== CACHE_FORMAT
      || entry.fingerprint !== this.fingerprint
      || entry.inputPath !== inputPath
      || !Array.isArray(entry.outputs)) {
      this.entries.set(inputPath, null);
      return null;
    }
    // `outputs` carries the sizes; `written` is kept byte-for-byte as the
    // compiler returned it, so a reused result is indistinguishable from a
    // fresh one.
    for (const written of entry.outputs) {
      let stats = null;
      try {
        stats = this.fileSystem.statSync(written.outputPath);
      } catch (_) {
        stats = null;
      }
      // A class file deleted or truncated since it was recorded has to be
      // rebuilt; the cache describes what is on disk, it does not replace it.
      if (!stats || stats.size !== written.byteLength) {
        this.entries.set(inputPath, null);
        return null;
      }
    }
    this.entries.set(inputPath, entry);
    return entry;
  }

  /**
   * Record a finished file. Written per file rather than once at the end, so an
   * interrupted batch keeps everything it had already completed.
   */
  write(inputPath, entry) {
    const record = { ...entry, format: CACHE_FORMAT, fingerprint: this.fingerprint, inputPath };
    try {
      this.fileSystem.mkdirSync(this.directory, { recursive: true });
      const text = JSON.stringify(record);
      this.fileSystem.writeFileSync(
        this.entryPath(inputPath),
        zlib ? zlib.gzipSync(text, { level: 1 }) : text,
      );
    } catch (_) {
      // A cache that cannot be written must not fail the compile it was only
      // meant to speed up; the next run simply rebuilds.
      return;
    }
    this.entries.set(inputPath, record);
  }
}

/**
 * Build the cache for a batch, or null when incremental compilation is off.
 * @param {object} options - `compileJavaFiles` options
 * @param {string} sourceRoot - resolved root the batch resolves names against
 * @returns {BuildCache|null}
 */
function createBuildCache(options, sourceRoot) {
  const settings = options.incremental === true ? {} : options.incremental;
  if (!settings) return null;
  if (!options.outputDir) {
    throw new TypeError('incremental compilation requires an outputDir to reuse class files from');
  }
  return new BuildCache(settings, options, sourceRoot);
}

module.exports = {
  CACHE_DIRECTORY_NAME,
  CACHE_FORMAT,
  createBuildCache,
  digest,
};
