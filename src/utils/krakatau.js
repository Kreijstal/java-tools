const fs = require('fs');
const path = require('path');

const KRAK2_RELATIVE_PATH = ['tools', 'krakatau', 'Krakatau', 'target', 'release', 'krak2'];

function resolveRepoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function ensureKrak2Path(baseDir = resolveRepoRoot()) {
  const candidate = path.resolve(baseDir, ...KRAK2_RELATIVE_PATH);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Krakatau binary not found at ${candidate}`);
  }
  return candidate;
}

module.exports = {
  ensureKrak2Path,
};
