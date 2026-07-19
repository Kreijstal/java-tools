'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('tape');
const { ensureKrak2Path } = require('../src/utils/krakatau');

const fixturePath = path.join(__dirname, 'fixtures', 'krakatau', 'ToStringObfuscationGuards.j');
const runCfrPath = path.join(__dirname, '..', 'scripts', 'runCfr.js');

function runDecompiler(inputDir, outputDir, diagnosticsPath, extraArgs = []) {
  return spawnSync(process.execPath, [
    runCfrPath,
    '--silent',
    '--diagnostics-json', diagnosticsPath,
    '--outputdir', outputDir,
    ...extraArgs,
    inputDir,
  ], { encoding: 'utf8' });
}

test('Krakatau fixture detects throwing toString obfuscation guards through the CLI', (t) => {
  let krak2Path;
  try {
    krak2Path = process.env.KRAK2 || ensureKrak2Path();
  } catch (err) {
    t.skip(`Krakatau is not installed: ${err.message}`);
    t.end();
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-obfuscation-guards-'));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const classesDir = path.join(tempDir, 'classes');
  const disabledSourceDir = path.join(tempDir, 'disabled-source');
  const enabledSourceDir = path.join(tempDir, 'enabled-source');
  const disabledDiagnosticsPath = path.join(tempDir, 'disabled.json');
  const enabledDiagnosticsPath = path.join(tempDir, 'enabled.json');

  fs.mkdirSync(classesDir);
  const assembly = spawnSync(krak2Path, ['asm', '--out', classesDir, fixturePath], { encoding: 'utf8' });
  t.equal(assembly.status, 0, `Krakatau assembles the fixture: ${assembly.stdout}${assembly.stderr}`);
  if (assembly.status !== 0) {
    t.end();
    return;
  }
  t.ok(fs.existsSync(path.join(classesDir, 'GuardedToString.class')), 'hostile testcase class is assembled');
  t.ok(fs.existsSync(path.join(classesDir, 'SafeToString.class')), 'safe control class is assembled');

  const disabled = runDecompiler(classesDir, disabledSourceDir, disabledDiagnosticsPath);
  t.equal(disabled.status, 0, `decompiler succeeds with detection disabled: ${disabled.stderr}`);
  const disabledReport = JSON.parse(fs.readFileSync(disabledDiagnosticsPath, 'utf8'));
  t.equal(disabledReport.obfuscationGuards.length, 0, 'detector is disabled by default');

  const enabled = runDecompiler(classesDir, enabledSourceDir, enabledDiagnosticsPath, [
    '--detect-obfuscation-guards',
  ]);
  t.equal(enabled.status, 0, `decompiler succeeds with detection enabled: ${enabled.stderr}`);
  t.match(enabled.stderr, /OBFUSCATION_GUARD GuardedToString\.toString/, 'CLI reports the hostile override');
  t.notOk(/OBFUSCATION_GUARD SafeToString\.toString/.test(enabled.stderr), 'CLI does not report the safe control');

  const enabledReport = JSON.parse(fs.readFileSync(enabledDiagnosticsPath, 'utf8'));
  t.equal(enabledReport.hardFailures, 0, 'guard warning is not a hard decompilation failure');
  t.deepEqual(enabledReport.obfuscationGuards, [{
    name: 'GuardedToString.java',
    kind: 'obfuscationGuard',
    guard: 'throwingToString',
    severity: 'warning',
    className: 'GuardedToString',
    methodName: 'toString',
    descriptor: '()Ljava/lang/String;',
    exceptionType: 'java/lang/IllegalStateException',
    message: 'toString override immediately throws IllegalStateException',
  }], 'diagnostics JSON identifies only the Krakatau hostile testcase');
  t.end();
});
