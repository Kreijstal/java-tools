#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function usage(exitCode) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/run-krakatau-decompiler-tests.js [options]\n\n`);
  stream.write(`Run Krakatau v1's semantic decompiler corpus against CFR-JS.\n\n`);
  stream.write(`Options:\n`);
  stream.write(`  --krakatau-repo <dir>  Krakatau Git checkout (default: tools/krakatau/Krakatau)\n`);
  stream.write(`  --ref <ref>            Krakatau revision containing v1 tests (default: origin/master)\n`);
  stream.write(`  --java-home <dir>      JDK used for javac/java (default: JAVA_HOME or JDK 11)\n`);
  stream.write(`  --case <name[,name]>   Run only selected registered cases\n`);
  stream.write(`  --runtime-timeout-ms N Timeout for each Java execution (default: 10000)\n`);
  stream.write(`  --workdir <dir>        Preserve artifacts at an explicit location\n`);
  stream.write(`  --report <file>        JSON report path (default: <workdir>/report.json)\n`);
  stream.write(`  --help, -h             Show this help text\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    krakatauRepo: path.join(ROOT, 'tools', 'krakatau', 'Krakatau'),
    ref: 'origin/master',
    javaHome: process.env.JAVA_HOME || '/usr/lib/jvm/java-11-openjdk',
    cases: null,
    runtimeTimeoutMs: 10000,
    workdir: null,
    report: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (!['--krakatau-repo', '--ref', '--java-home', '--case', '--runtime-timeout-ms', '--workdir', '--report'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
    const value = argv[++i];
    if (arg === '--krakatau-repo') options.krakatauRepo = path.resolve(value);
    else if (arg === '--ref') options.ref = value;
    else if (arg === '--java-home') options.javaHome = path.resolve(value);
    else if (arg === '--case') options.cases = new Set(value.split(',').filter(Boolean));
    else if (arg === '--runtime-timeout-ms') options.runtimeTimeoutMs = Number(value);
    else if (arg === '--workdir') options.workdir = path.resolve(value);
    else if (arg === '--report') options.report = path.resolve(value);
  }
  if (!Number.isFinite(options.runtimeTimeoutMs) || options.runtimeTimeoutMs <= 0) {
    throw new Error('--runtime-timeout-ms must be a positive number');
  }
  return options;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function commandFailure(result) {
  if (result.error) return result.error.message;
  return `${result.stderr || ''}${result.stdout || ''}`.trim();
}

function gitRead(repo, ref, relativePath) {
  const result = spawnSync('git', ['show', `${ref}:${relativePath}`], {
    cwd: repo,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Cannot read ${relativePath} from Krakatau ${ref}: ${String(result.stderr || '')}`);
  }
  return result.stdout;
}

function loadRegistry(registryPath) {
  const code = [
    'import importlib.util, json, sys',
    "spec = importlib.util.spec_from_file_location('krakatau_decompiler_tests', sys.argv[1])",
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(json.dumps(module.registry, ensure_ascii=False, sort_keys=True))',
  ].join('\n');
  const result = run('python3', ['-c', code, registryPath]);
  if (result.status !== 0) throw new Error(`Cannot load Krakatau registry: ${commandFailure(result)}`);
  return JSON.parse(result.stdout);
}

function processResult(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function sameKrakatauOutput(left, right) {
  // Krakatau's run_and_compare_java serializes and compares stdout/stderr only.
  return left.stdout === right.stdout && left.stderr === right.stderr;
}

function originalClassUnsupportedByHost(result) {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  return /UnsupportedClassVersionError:[\s\S]*invalid non-zero minor version/.test(output)
    || /ClassFormatError: Illegal class name /.test(output);
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.krakatauRepo)) throw new Error(`Krakatau checkout not found: ${options.krakatauRepo}`);
  const java = path.join(options.javaHome, 'bin', 'java');
  const javac = path.join(options.javaHome, 'bin', 'javac');
  if (!fs.existsSync(java) || !fs.existsSync(javac)) throw new Error(`JDK not found under ${options.javaHome}`);

  const workdir = options.workdir || fs.mkdtempSync(path.join(os.tmpdir(), 'krakatau-cfr-suite-'));
  const corpusDir = path.join(workdir, 'upstream-classes');
  const casesDir = path.join(workdir, 'cases');
  fs.mkdirSync(corpusDir, { recursive: true });
  fs.mkdirSync(casesDir, { recursive: true });

  const registryPath = path.join(workdir, 'krakatau-decompiler-registry.py');
  fs.writeFileSync(registryPath, gitRead(options.krakatauRepo, options.ref, 'tests/decompiler/__init__.py'));
  const registry = loadRegistry(registryPath);
  let names = Object.keys(registry).sort();
  if (options.cases) {
    const unknown = [...options.cases].filter((name) => !Object.prototype.hasOwnProperty.call(registry, name));
    if (unknown.length) throw new Error(`Unknown Krakatau case(s): ${unknown.join(', ')}`);
    names = names.filter((name) => options.cases.has(name));
  }

  for (const name of names) {
    fs.writeFileSync(path.join(corpusDir, `${name}.class`),
      gitRead(options.krakatauRepo, options.ref, `tests/decompiler/classes/${name}.class`));
  }

  const refResult = run('git', ['rev-parse', options.ref], { cwd: options.krakatauRepo });
  if (refResult.status !== 0) throw new Error(`Cannot resolve Krakatau ref ${options.ref}`);
  const results = [];
  let argumentRuns = 0;
  const registeredArgumentRuns = names.reduce((sum, name) => sum + registry[name].length, 0);

  for (const name of names) {
    const caseDir = path.join(casesDir, name);
    const sourceDir = path.join(caseDir, 'source');
    const classDir = path.join(caseDir, 'classes');
    const diagnosticsPath = path.join(caseDir, 'diagnostics.json');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(classDir, { recursive: true });

    const decompile = run(process.execPath, [
      path.join(ROOT, 'scripts', 'runCfr.js'),
      '--silent',
      '--classpath', corpusDir,
      '--diagnostics-json', diagnosticsPath,
      '--outputdir', sourceDir,
      path.join(corpusDir, `${name}.class`),
    ]);
    const sourcePath = path.join(sourceDir, `${name}.java`);
    if (decompile.status !== 0 || !fs.existsSync(sourcePath)) {
      results.push({
        name,
        status: 'decompile-fail',
        detail: commandFailure(decompile) || 'decompiler emitted no source file',
        diagnostics: readJsonIfPresent(diagnosticsPath),
      });
      console.log(`DECOMPILE_FAIL ${name}`);
      continue;
    }

    const compile = run(javac, ['-g:none', '-cp', corpusDir, '-d', classDir, sourcePath]);
    if (compile.status !== 0) {
      results.push({
        name,
        status: 'javac-fail',
        detail: commandFailure(compile),
        diagnostics: readJsonIfPresent(diagnosticsPath),
      });
      console.log(`JAVAC_FAIL ${name}`);
      continue;
    }

    const mismatches = [];
    const environmentSkips = [];
    for (const args of registry[name]) {
      argumentRuns += 1;
      const original = processResult(run(java, ['-cp', corpusDir, name, ...args], {
        timeout: options.runtimeTimeoutMs,
      }));
      const regenerated = processResult(run(java, [
        '-cp', `${classDir}${path.delimiter}${corpusDir}`, name, ...args,
      ], { timeout: options.runtimeTimeoutMs }));
      if (originalClassUnsupportedByHost(original)) {
        environmentSkips.push({ args, original, regenerated });
        continue;
      }
      if (!sameKrakatauOutput(original, regenerated)) {
        mismatches.push({ args, original, regenerated });
      }
    }
    if (mismatches.length) {
      results.push({ name, status: 'runtime-mismatch', mismatchCount: mismatches.length, mismatches, environmentSkips });
      console.log(`RUNTIME_MISMATCH ${name} mismatches=${mismatches.length}/${registry[name].length}`);
    } else if (environmentSkips.length) {
      results.push({ name, status: 'environment-skip', skipCount: environmentSkips.length, environmentSkips });
      console.log(`ENVIRONMENT_SKIP ${name} unsupported-by-host-jvm=${environmentSkips.length}/${registry[name].length}`);
    } else {
      results.push({ name, status: 'pass', runs: registry[name].length });
      console.log(`PASS ${name} runs=${registry[name].length}`);
    }
  }

  const counts = results.reduce((out, item) => {
    out[item.status] = (out[item.status] || 0) + 1;
    return out;
  }, {});
  const reportPath = options.report || path.join(workdir, 'report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    formatVersion: 1,
    krakatau: { repo: options.krakatauRepo, ref: options.ref, commit: refResult.stdout.trim() },
    javaHome: options.javaHome,
    workdir,
    selectedCases: names,
    registeredArgumentRuns,
    runtimeArgumentRuns: argumentRuns,
    counts,
    results,
  }, null, 2)}\n`);
  console.log(`SUMMARY ${JSON.stringify(counts)}`);
  console.log(`REPORT ${reportPath}`);
  if (results.some((item) => item.status !== 'pass' && item.status !== 'environment-skip')) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
