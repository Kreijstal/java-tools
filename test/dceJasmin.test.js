const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { execFileSync } = require('child_process');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');

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

test('assembler accepts Krakatau stack_1 frame names', (t) => {
  t.plan(2);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-1-'));
  const source = fs.readFileSync(FIXTURE, 'utf8');
  try {
    const compactPath = path.join(tempDir, 'MisplacedCatch.class');
    assembleJasminSource(source, compactPath);
    const compact = execFileSync('javap', ['-v', compactPath], { encoding: 'utf8' });
    t.match(compact, /\/\* same_locals_1_stack_item \*\//,
      'stack_1 encodes a compact one-stack-item frame');

    const extendedPath = path.join(tempDir, 'MisplacedCatchExtended.class');
    assembleJasminSource(source.replace(/\.stack stack_1 /g, '.stack stack_1_extended '), extendedPath);
    const extended = execFileSync('javap', ['-v', extendedPath], { encoding: 'utf8' });
    t.match(extended, /\/\* same_locals_1_stack_item_frame_extended \*\//,
      'stack_1_extended encodes an extended one-stack-item frame');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
