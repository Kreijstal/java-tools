'use strict';

// Does the compile worker actually work in a browser?
//
// Every non-blocking result recorded for Phase 1 was obtained in Node, on
// `worker_threads`. The stated objective is fps in stock Firefox, and until
// the host adapter landed a browser had no compile worker at all. Code that
// merely *compiles* for a browser proves nothing about that, so this drives
// the real protocol -- init, ready, a pushed class, a compile request, a
// result payload -- through a real Firefox Worker running dist/.
//
// It is a script and not a test file: it needs a built bundle and a browser,
// neither of which belongs in the unit suite.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const JitCompiler = require('../src/jit/JitCompiler');
const frontend = require('../src/java-frontend');

const DIST = path.resolve(__dirname, '..', 'dist');
const BUNDLE = path.join(DIST, 'jvm-compile-worker.js');
const STRIDE = 4096;

async function buildFixture() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cw-'));
  frontend.compileJavaFile(
    path.resolve(__dirname, '../sources/HotnessProbe.java'),
    { outputDir, sourceFileName: 'HotnessProbe.java' });
  const jvm = new JVM({ classpath: outputDir, jit: { compileWorker: false } });
  await jvm.loadClassByName('HotnessProbe');
  jvm.classInitializationState.set('HotnessProbe', 'INITIALIZED');

  const classData = jvm.classes.HotnessProbe;
  const items = classData.ast.classes[0].items.filter(i => i.type === 'method');
  // Any method with a body will do; the point is that a body crosses at all.
  const target = items.find(i => i.method.name !== '<init>' &&
    i.method.attributes?.some(a => a.type === 'code'));
  if (!target) throw new Error('no compilable method in the probe');

  const grant = jvm.jit.siteIdWatermark();
  const limit = { ...grant };
  for (const table of JitCompiler.transportableSiteTables) {
    limit[table] = grant[table] + STRIDE;
  }
  fs.rmSync(outputDir, { recursive: true, force: true });
  return {
    request: {
      type: 'compile', id: 1,
      className: 'HotnessProbe',
      name: target.method.name,
      descriptor: target.method.descriptor,
      preparedWholeMethod: false,
      provenance: jvm.jit.captureResultProvenance(),
      grant, limit,
      classes: [{ className: 'HotnessProbe', initialized: true,
        ast: classData.ast, constantPool: classData.constantPool }],
    },
  };
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>compile worker</title>
<pre id="out">starting</pre>
<script>
const out = document.getElementById('out');
function done(state, detail) {
  window.__result = { state, detail };
  out.textContent = state + ': ' + detail;
}
fetch('fixture.json').then(r => r.json()).then((fixture) => {
  const worker = new Worker('jvm-compile-worker.js');
  let ready = false;
  const failed = setTimeout(() => done('fail', 'no result within 60s (ready=' + ready + ')'), 60000);
  worker.addEventListener('error', (event) =>
    done('fail', 'worker error: ' + (event.message || 'unknown')));
  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'ready') {
      ready = true;
      worker.postMessage(fixture.request);
      return;
    }
    if (!message || message.type !== 'result') return;
    clearTimeout(failed);
    if (message.refused) { done('refused', message.refused); return; }
    if (!message.payload) { done('fail', 'result carried no payload'); return; }
    done('ok', 'payload keys: ' + Object.keys(message.payload).sort().join(','));
  });
  // No workerData in a browser: configuration is the first message.
  worker.postMessage({ type: 'init', classpath: [], jitOptions: {} });
}).catch((error) => done('fail', 'page threw: ' + error.message));
</script>`;

// This repository's playwright pins a Firefox build that was never
// downloaded here, and `launch()` then fails inside a script whose HTTP server
// keeps the event loop alive -- so the first run of this hung for 46 minutes
// printing nothing instead of failing in one second. Pick an install whose
// browser is actually on disk, and say which one, so the run is reproducible
// rather than dependent on whichever checkout was installed last.
function resolveFirefox() {
  const tried = [];
  const candidates = [require.resolve('playwright')];
  const workspace = path.resolve(__dirname, '..', '..');
  let siblings = [];
  try { siblings = fs.readdirSync(workspace); } catch (error) { siblings = []; }
  for (const sibling of siblings) {
    const candidate = path.join(workspace, sibling, 'node_modules', 'playwright');
    if (candidate !== candidates[0] && fs.existsSync(candidate)) {
      candidates.push(candidate);
    }
  }
  for (const candidate of candidates) {
    try {
      const { firefox } = require(candidate);
      const executable = firefox.executablePath();
      if (fs.existsSync(executable)) return firefox;
      tried.push(`${candidate}: no browser at ${executable}`);
    } catch (error) {
      tried.push(`${candidate}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error('no playwright install has its Firefox downloaded:\n  ' +
    tried.join('\n  '));
}

async function main() {
  if (!fs.existsSync(BUNDLE)) {
    throw new Error(`missing ${BUNDLE} -- run: npx webpack --config webpack.config.js`);
  }
  const fixture = await buildFixture();
  const fixtureJson = JSON.stringify(fixture);

  const server = http.createServer((request, response) => {
    const url = request.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }
    if (url === '/fixture.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(fixtureJson);
      return;
    }
    const file = path.join(DIST, path.basename(url));
    if (fs.existsSync(file)) {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      fs.createReadStream(file).pipe(response);
      return;
    }
    response.writeHead(404).end('not found');
  });
  // Loopback only: this serves a bundle and a fixture, and nothing here is
  // anyone else's business.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const firefox = resolveFirefox();
  console.log(`firefox: ${firefox.executablePath()}`);
  const browser = await firefox.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(`http://127.0.0.1:${port}/`);
  let result;
  try {
    await page.waitForFunction('window.__result !== undefined',
      null, { timeout: 90000 });
    result = await page.evaluate('window.__result');
  } catch (error) {
    result = { state: 'fail', detail: `page never reported: ${error.message}` };
  }
  await browser.close();
  server.close();

  console.log(`result: ${result.state}`);
  console.log(`detail: ${result.detail}`);
  if (consoleErrors.length) {
    console.log('console errors:');
    for (const line of consoleErrors.slice(0, 10)) console.log('  ' + line);
  }
  // A JVM was constructed to build the fixture and the server held a socket;
  // either can keep the loop alive after the answer is known. Exiting is the
  // difference between a failed check and a silent hang.
  process.exit(result.state === 'ok' ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
