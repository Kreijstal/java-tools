const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'optimize-j.js');
const FIXTURE = path.join(__dirname, '..', 'examples', 'sources', 'jasmin', 'MisplacedCatch.j');

test('optimize-j removes dead throw/goto from Jasmin files', (t) => {
  t.plan(2);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcej-'));
  const inputPath = path.join(tempDir, 'MisplacedCatch.j');
  const outputPath = path.join(tempDir, 'MisplacedCatch.optimized.j');
  fs.copyFileSync(FIXTURE, inputPath);

  execFileSync(process.execPath, [SCRIPT, inputPath, outputPath], { stdio: 'inherit' });

  const optimized = fs.readFileSync(outputPath, 'utf8');
  t.doesNotMatch(optimized, /\bathrow\b/, 'Dead athrow should be removed from optimized Jasmin');
  t.doesNotMatch(optimized, /\bgoto\s+L18\b/, 'Redundant goto to handler should be eliminated');

  fs.rmSync(tempDir, { recursive: true, force: true });
});
