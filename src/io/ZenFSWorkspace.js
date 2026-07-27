'use strict';

const { WorkspaceFileSystem } = require('./WorkspaceFileSystem');

let defaultWorkspacePromise = null;

/**
 * Create the browser's default in-memory workspace using ZenFS.
 *
 * Dynamic import keeps the editor filesystem out of the JVM's startup path and
 * is required because ZenFS is distributed as an ES module while java-tools
 * also supports CommonJS consumers.
 */
async function createZenFSWorkspace(options = {}) {
  const zenfs = await import('@zenfs/core');
  zenfs.configureSingleSync({
    backend: zenfs.InMemory,
    name: options.name || 'java-tools-workspace',
  });
  return new WorkspaceFileSystem(zenfs.fs, { root: options.root || '/' });
}

function getDefaultZenFSWorkspace(options = {}) {
  if (!defaultWorkspacePromise) {
    defaultWorkspacePromise = createZenFSWorkspace(options);
  }
  return defaultWorkspacePromise;
}

module.exports = {
  createZenFSWorkspace,
  getDefaultZenFSWorkspace,
};
