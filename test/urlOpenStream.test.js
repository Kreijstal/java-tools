'use strict';
// URL.openStream() returns the response body. It used to require a Node
// event stream, so in browsers every openStream threw "unsupported response
// stream" and games' error reports (clienterror.ws) never reached the server.
const test = require('tape');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// runJvm.js waits on an open stdin pipe, so the child gets none.
function runJvm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'runJvm.js'), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 90000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const ROOT = path.join(__dirname, '..');
const hasJavac = !spawnSync('javac', ['-version']).error;

test('URL.openStream reads the whole response body', { skip: !hasJavac && 'javac unavailable', timeout: 120000 }, async (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'url-open-stream-'));
  spawnSync('javac', ['--release', '8', '-d', classes, path.join(__dirname, 'fixtures', 'net', 'UrlRead.java')], { stdio: 'inherit' });
  const body = Buffer.from([0x3c, 0x00, 0xff, 0x80, 0x7f, 1, 2, 3]);
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/octet-stream');
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/clienterror.ws?c=1&e=report`;
    const { code, stdout, stderr } = await runJvm(['-cp', classes, 'UrlRead', url]);
    t.equal(code, 0, stderr.slice(0, 2000));
    t.equal(stdout.trim(), `first=60 bytes=${body.length}`);
  } finally {
    server.close();
    fs.rmSync(classes, { recursive: true, force: true });
  }
});
