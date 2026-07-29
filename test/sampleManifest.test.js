'use strict';

const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, '..', 'dist');
const dataDir = path.join(distDir, 'data');
const manifestPath = path.join(dataDir, 'manifest.json');

function loadManifest() {
  if (!fs.existsSync(manifestPath)) {
    console.log('Generating sample data...');
    execSync('npm run generate', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('sample manifest describes the shipped sources', (t) => {
  const manifest = loadManifest();
  t.ok(Array.isArray(manifest.samples), 'manifest has a samples array');
  t.ok(manifest.samples.length >= 130, `manifest lists all sample sources (${manifest.samples.length})`);

  const bySource = new Map(manifest.samples.map((sample) => [sample.source, sample]));

  const hello = bySource.get('Hello.java');
  t.ok(hello, 'Hello.java is listed');
  t.deepEqual(hello.classes, ['Hello'], 'Hello.java produces the Hello class');
  t.deepEqual(
    hello.runnable,
    [{ classPath: 'Hello.class', launchMode: 'application' }],
    'Hello is a runnable application',
  );

  const applet = bySource.get('PyramidApplet.java');
  t.ok(applet, 'PyramidApplet.java is listed');
  t.equal(applet.runnable[0].launchMode, 'applet', 'PyramidApplet is detected as an applet');

  const mainApp = bySource.get('MainApp.java');
  t.ok(mainApp, 'MainApp.java is listed');
  t.deepEqual(
    [...mainApp.dependsOn].sort(),
    ['Thing.java', 'ThingProducer.java'],
    'MainApp records its cross-file dependency closure',
  );

  const runnableCount = manifest.samples.reduce((sum, sample) => sum + sample.runnable.length, 0);
  t.ok(runnableCount >= 20, `manifest exposes runnable samples (${runnableCount})`);
  t.end();
});

test('every manifest source file is shipped alongside it', (t) => {
  const manifest = loadManifest();
  for (const sample of manifest.samples) {
    if (!fs.existsSync(path.join(dataDir, sample.source))) {
      t.fail(`missing shipped source: ${sample.source}`);
      t.end();
      return;
    }
    for (const dependency of sample.dependsOn) {
      if (!manifest.samples.some((entry) => entry.source === dependency)) {
        t.fail(`${sample.source} depends on unlisted source ${dependency}`);
        t.end();
        return;
      }
    }
  }
  t.pass('all manifest sources exist in dist/data and dependencies are listed');
  t.ok(!fs.existsSync(path.join(distDir, 'data.zip')), 'no data.zip is produced anymore');
  t.end();
});
