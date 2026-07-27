'use strict';

const path = require('path');

function copyBytes(value) {
  if (typeof value === 'string') {
    return value;
  }
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : null;
  if (!bytes) {
    throw new TypeError('Workspace file content must be a string, ArrayBuffer, or typed array');
  }
  return new Uint8Array(bytes);
}

/**
 * A small, backend-independent workspace filesystem.
 *
 * The wrapped object follows Node's synchronous fs API. Keeping this boundary
 * deliberately small lets the browser use ZenFS while Node callers continue
 * to use the host filesystem.
 */
class WorkspaceFileSystem {
  constructor(fileSystem, options = {}) {
    if (!fileSystem || typeof fileSystem.readFileSync !== 'function') {
      throw new TypeError('WorkspaceFileSystem requires a synchronous fs-compatible backend');
    }
    this.backend = fileSystem;
    this.root = path.posix.resolve('/', options.root || '/');
    this.map = new WorkspaceMapAdapter(this);
  }

  resolve(filePath = '/') {
    const normalized = String(filePath).replace(/\\/g, '/');
    const relative = path.posix.resolve('/', normalized).slice(1);
    const resolved = path.posix.resolve(this.root, relative);
    if (this.root !== '/' && resolved !== this.root && !resolved.startsWith(`${this.root}/`)) {
      throw new Error(`Workspace path escapes its root: ${filePath}`);
    }
    return resolved;
  }

  existsSync(filePath) {
    return this.backend.existsSync(this.resolve(filePath));
  }

  readFileSync(filePath, options) {
    return this.backend.readFileSync(this.resolve(filePath), options);
  }

  writeFileSync(filePath, data, options) {
    return this.backend.writeFileSync(this.resolve(filePath), data, options);
  }

  mkdirSync(filePath, options) {
    return this.backend.mkdirSync(this.resolve(filePath), options);
  }

  readdirSync(filePath, options) {
    return this.backend.readdirSync(this.resolve(filePath), options);
  }

  statSync(filePath, options) {
    return this.backend.statSync(this.resolve(filePath), options);
  }

  renameSync(oldPath, newPath) {
    return this.backend.renameSync(this.resolve(oldPath), this.resolve(newPath));
  }

  unlinkSync(filePath) {
    return this.backend.unlinkSync(this.resolve(filePath));
  }

  rmSync(filePath, options) {
    return this.backend.rmSync(this.resolve(filePath), options);
  }

  listFiles(filePath = '/') {
    const start = this.resolve(filePath);
    if (!this.backend.existsSync(start)) return [];
    const files = [];
    const visit = (directory) => {
      for (const entry of this.backend.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.posix.join(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (entry.isFile()) files.push(this.relativePath(entryPath));
      }
    };
    const stat = this.backend.statSync(start);
    if (stat.isDirectory()) visit(start);
    else files.push(this.relativePath(start));
    return files.sort();
  }

  relativePath(absolutePath) {
    return path.posix.relative(this.root, absolutePath).replace(/\\/g, '/');
  }

  clear() {
    if (!this.backend.existsSync(this.root)) return;
    for (const name of this.backend.readdirSync(this.root)) {
      this.backend.rmSync(path.posix.join(this.root, name), { recursive: true, force: true });
    }
  }
}

/**
 * Compatibility view for existing BrowserFileProvider callers. New code should
 * use WorkspaceFileSystem directly; this adapter can be removed after callers
 * no longer reach into BrowserFileProvider.virtualFS.
 */
class WorkspaceMapAdapter {
  constructor(workspace) {
    this.workspace = workspace;
  }

  has(filePath) {
    return this.workspace.existsSync(filePath);
  }

  get(filePath) {
    if (!this.has(filePath)) return undefined;
    return copyBytes(this.workspace.readFileSync(filePath));
  }

  set(filePath, content) {
    const resolved = this.workspace.resolve(filePath);
    this.workspace.backend.mkdirSync(path.posix.dirname(resolved), { recursive: true });
    this.workspace.backend.writeFileSync(resolved, copyBytes(content));
    return this;
  }

  delete(filePath) {
    if (!this.has(filePath)) return false;
    this.workspace.rmSync(filePath, { recursive: true, force: true });
    return true;
  }

  clear() {
    this.workspace.clear();
  }

  keys() {
    return this.workspace.listFiles().values();
  }

  entries() {
    const entries = this.workspace.listFiles().map((filePath) => [filePath, this.get(filePath)]);
    return entries.values();
  }

  values() {
    const values = this.workspace.listFiles().map((filePath) => this.get(filePath));
    return values.values();
  }

  get size() {
    return this.workspace.listFiles().length;
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

module.exports = {
  WorkspaceFileSystem,
  WorkspaceMapAdapter,
};
