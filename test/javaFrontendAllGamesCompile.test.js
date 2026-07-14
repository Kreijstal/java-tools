'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const frontend = require('../src/java-frontend');

function collectJavaFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.java')) files.push(entryPath);
    }
  }
  return files.sort();
}

function canonicalGames(baselinePath) {
  return fs.readFileSync(baselinePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t')[0]);
}

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
}

function isDirectory(directoryPath) {
  try { return fs.statSync(directoryPath).isDirectory(); } catch (_) { return false; }
}

function unsupportedJavaIr(result) {
  const artifacts = [];
  for (const classIr of (result.javaIr && result.javaIr.classes) || []) {
    for (const method of classIr.methods || []) {
      for (const block of method.blocks || []) {
        for (const op of block.ops || []) {
          if (op.op === 'unsupported' || op.op === 'expression') {
            artifacts.push(`${classIr.internalName}.${method.name}${method.descriptor}: ${op.op}`);
          }
        }
      }
    }
  }
  return artifacts;
}

function unsupportedBytecode(result) {
  const artifacts = [];
  for (const classIr of (result.bytecodeIr && result.bytecodeIr.classes) || []) {
    for (const method of classIr.methods || []) {
      for (const instruction of method.instructions || []) {
        if (instruction.opcode === 'unsupported') {
          artifacts.push(`${classIr.internalName}.${method.name}${method.descriptor}`);
        }
      }
    }
  }
  return artifacts;
}

test('Java frontend lowers every canonical game source back to bytecode', (t) => {
  const dekoblokoRoot = path.resolve(
    process.env.DEKOBLOKO_WORK_DIR || path.join(__dirname, '..', '..', 'dekobloko-work'),
  );
  const gamesRoot = path.resolve(
    process.env.DEKOBLOKO_GAMES_ROOT || path.join(dekoblokoRoot, '.work', 'games'),
  );
  const baselinePath = path.resolve(
    process.env.DEKOBLOKO_GAMES_BASELINE
      || path.join(dekoblokoRoot, 'scripts', 'EXPECTED-OWN-DECOMPILER-ALL-GAMES.tsv'),
  );

  const corpusConfigured = Boolean(
    process.env.DEKOBLOKO_WORK_DIR
      || process.env.DEKOBLOKO_GAMES_ROOT
      || process.env.DEKOBLOKO_GAMES_BASELINE,
  );
  if (!isFile(baselinePath) || !isDirectory(gamesRoot)) {
    if (corpusConfigured) {
      t.ok(isFile(baselinePath), `canonical game baseline exists: ${baselinePath}`);
      t.ok(isDirectory(gamesRoot), `generated game corpus exists: ${gamesRoot}`);
    } else {
      t.pass('external generated-game corpus is unavailable; corpus gate skipped');
    }
    t.end();
    return;
  }

  t.ok(isFile(baselinePath), `canonical game baseline exists: ${baselinePath}`);
  t.ok(isDirectory(gamesRoot), `generated game corpus exists: ${gamesRoot}`);

  const games = canonicalGames(baselinePath);
  t.equal(games.length, 44, 'all 44 canonical games are listed by the baseline');
  const corpus = games.map((game) => {
    const sourceDir = path.join(gamesRoot, game, 'decompile-owned', 'java');
    t.ok(isDirectory(sourceDir), `${game} generated Java directory exists`);
    return { game, sourceDir, files: isDirectory(sourceDir) ? collectJavaFiles(sourceDir) : [] };
  });
  const missingSources = corpus.filter((entry) => entry.files.length === 0).map((entry) => entry.game);
  t.deepEqual(missingSources, [], 'every canonical game contributes generated Java sources');
  if (missingSources.length > 0) {
    t.end();
    return;
  }

  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-frontend-games-'));
  let sourceCount = 0;
  let classCount = 0;
  const javaIrArtifacts = [];
  const bytecodeArtifacts = [];
  try {
    for (const { game, files } of corpus) {
      const outputDir = path.join(outputRoot, game);
      for (const inputPath of files) {
        let result;
        try {
          result = frontend.compileJavaFile(inputPath, {
            outputDir,
            sourceFileName: path.basename(inputPath),
            fallbackUnsupportedTypes: false,
          });
        } catch (error) {
          error.message = `${game}/${path.relative(path.join(gamesRoot, game, 'decompile-owned', 'java'), inputPath)}: ${error.message}`;
          throw error;
        }
        sourceCount += 1;
        classCount += (result.written || []).length;
        javaIrArtifacts.push(...unsupportedJavaIr(result).map((item) => `${game}/${path.basename(inputPath)}: ${item}`));
        bytecodeArtifacts.push(...unsupportedBytecode(result).map((item) => `${game}/${path.basename(inputPath)}: ${item}`));
      }
      t.pass(`${game}: ${files.length} sources lower to bytecode`);
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }

  t.ok(sourceCount > 0, `the game corpus contains ${sourceCount} Java sources`);
  t.ok(classCount >= sourceCount, `the frontend emitted ${classCount} class files for ${sourceCount} sources`);
  t.deepEqual(javaIrArtifacts, [], 'no unsupported Java IR artifacts occur in any game');
  t.deepEqual(bytecodeArtifacts, [], 'no unsupported bytecode artifacts occur in any game');
  t.end();
});
