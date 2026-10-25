'use strict';
// Shared harness for the closed-world tests: compile a fixture with javac,
// run it on HotSpot for the reference output, run it on jvm.js in a child
// process and capture exactly what the guest prints. A child process keeps
// the test runner's own stdout protocol out of the captured output.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const compiled = new Map();
function compileFixture(name) {
  if (compiled.has(name)) return compiled.get(name);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `closed-${name}-`));
  execFileSync('javac', ['--release', '8', '-nowarn', '-d', directory,
    path.join(__dirname, '..', 'fixtures', 'closed', `${name}.java`)], { stdio: ['ignore', 'ignore', 'pipe'] });
  compiled.set(name, directory);
  return directory;
}

function hotspot(directory, mainClass) {
  return execFileSync('java', ['-Xmx256m', '-cp', directory, mainClass], { encoding: 'utf8' });
}

const RUNNER = `
const { JVM } = require(process.env.CLOSED_JVM_PATH);
const options = JSON.parse(process.env.CLOSED_OPTIONS);
(async () => {
  const jvm = new JVM(options);
  let failure = null;
  try { await jvm.run(process.env.CLOSED_MAIN); } catch (error) { failure = String(error && (error.stack || error.message || error.type) || error); }
  const closed = jvm.jit?.closedWorld;
  process.stderr.write('\\nCLOSED_STATS ' + JSON.stringify({ failure, stats: closed ? closed.stats() : null }) + '\\n');
})();
`;

function parseStats(stderr) {
  const line = stderr.split('\n').reverse().find((l) => l.startsWith('CLOSED_STATS '));
  return line ? JSON.parse(line.slice('CLOSED_STATS '.length)) : { failure: null, stats: null };
}

// Returns {output, stderr, failure, stats}; `stats` describes the closed
// module (null when closed-world compilation is off).
function runDetailed(directory, mainClass, options = {}) {
  const { spawnSync } = require('node:child_process');
  const env = {
    ...process.env,
    CLOSED_JVM_PATH: path.join(__dirname, '..', '..', 'src', 'core', 'jvm.js'),
    CLOSED_OPTIONS: JSON.stringify({ classpath: directory, wasmHeap: true, ...options }),
    CLOSED_MAIN: mainClass,
  };
  const node = options.jspiNode ? jspiNode() : process.execPath;
  const jvmOptions = { ...options };
  delete jvmOptions.jspiNode;
  env.CLOSED_OPTIONS = JSON.stringify({ classpath: directory, wasmHeap: true, ...jvmOptions });
  const result = spawnSync(node, ['-e', RUNNER], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.error) throw result.error;
  const parsed = parseStats(result.stderr || '');
  return { output: result.stdout, stderr: result.stderr, ...parsed };
}

async function runJvmJs(directory, mainClass, options = {}) {
  const result = runDetailed(directory, mainClass, options);
  if (result.failure) throw new Error(`guest failed: ${result.failure}\n${result.stderr}`);
  return result.output;
}

// A Node with JS Promise Integration (Node 24+): this one, JVM_JSPI_NODE, or
// /usr/bin/node. null when none is available.
let jspiNodePath;
function jspiNode() {
  if (jspiNodePath !== undefined) return jspiNodePath;
  const { spawnSync } = require('node:child_process');
  const probe = "process.stdout.write(String(typeof WebAssembly.Suspending === 'function'))";
  for (const candidate of [process.execPath, process.env.JVM_JSPI_NODE, '/usr/bin/node']) {
    if (!candidate) continue;
    const result = spawnSync(candidate, ['-e', probe], { encoding: 'utf8' });
    if (result.stdout === 'true') return (jspiNodePath = candidate);
  }
  return (jspiNodePath = null);
}

module.exports = { compileFixture, hotspot, runJvmJs, runDetailed, jspiNode };
