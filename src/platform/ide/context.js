'use strict';

// Shared mutable context wired up by main.js at boot. Modules read from this
// instead of importing each other, which keeps the dependency graph flat.
module.exports = {
  layout: null,
  /** @returns {object|null} the shared WorkspaceFileSystem, once booted */
  workspace: null,
  /** reveal(panelKey): focus a bottom panel ('terminal'|'output'|'display'|'debug'|'bytecode') */
  reveal: () => {},
  /** re-render the explorer tree */
  refreshTree: () => {},
  /** open a file in an editor tab */
  openFile: () => {},
};
