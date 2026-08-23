'use strict';

/**
 * Terminal rendering for the `onProgress` hook of `compileJavaFiles` /
 * `compileWorkspace`. Kept out of the compiler itself: the library reports
 * structured events, and how they are drawn is the caller's business.
 */

/**
 * Build a progress reporter that prints one line per phase boundary and one
 * line per file.
 * @param {object} options
 * @param {(text: string) => void} [options.write] - sink; stderr by default, so
 *   a caller's machine-readable stdout stays untouched.
 * @returns {(event: object) => void} - pass as `onProgress`
 */
function createCompileProgressReporter(options = {}) {
  const write = options.write || ((text) => process.stderr.write(text));
  return function reportProgress(event) {
    const width = String(event.total).length;
    const counter = `[${String(event.completed).padStart(width)}/${event.total}]`;
    const phase = String(event.phase).padEnd(8);
    if (event.event === 'start') {
      write(`${phase} ${event.total} file${event.total === 1 ? '' : 's'}\n`);
      return;
    }
    if (event.event === 'end') {
      write(`${phase} ${counter} done in ${event.durationMs} ms\n`);
      return;
    }
    if (event.event === 'file-error') {
      write(`${phase} ${counter} FAILED ${event.inputPath}\n`);
      return;
    }
    if (event.event !== 'file-end') return;
    const label = event.inputPath || event.internalName || '';
    let detail = '';
    if (event.phase === 'compile') {
      detail = ` -> ${event.classes} class${event.classes === 1 ? '' : 'es'}`
        + `${event.unsupported ? `, ${event.unsupported} unsupported` : ''}`
        + ` (${event.durationMs} ms)`;
    } else if (event.phase === 'artifact') {
      detail = ` -> ${event.internalName} (${event.byteLength} bytes)`;
    }
    write(`${phase} ${counter} ${label}${detail}\n`);
  };
}

module.exports = { createCompileProgressReporter };
