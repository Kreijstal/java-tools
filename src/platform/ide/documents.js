'use strict';

const context = require('./context');
const {
  basename,
  extensionOf,
  normalizePath,
  setStatus,
  logLine,
} = require('./util');

// One document per absolute workspace path. `.java`, `.j`, and `.class` files
// are all distinct documents — a tab never changes which file it represents.
const openDocuments = new Map();
let activeDocumentPath = null;

const ACE_MODES = {
  java: 'ace/mode/java',
};

function aceModeFor(filePath) {
  return ACE_MODES[extensionOf(filePath)] || 'ace/mode/text';
}

function isClassFile(filePath) {
  return extensionOf(filePath) === 'class';
}

function getDocument(filePath) {
  return openDocuments.get(normalizePath(filePath)) || null;
}

function getActiveDocument() {
  if (activeDocumentPath && openDocuments.has(activeDocumentPath)) {
    return openDocuments.get(activeDocumentPath);
  }
  return null;
}

function setActiveDocument(filePath) {
  activeDocumentPath = filePath ? normalizePath(filePath) : null;
}

function tabTitle(doc) {
  return `${doc.dirty ? '● ' : ''}${basename(doc.path)}`;
}

function markDirty(doc, dirty) {
  if (doc.dirty === dirty) return;
  doc.dirty = dirty;
  doc.container.setTitle(tabTitle(doc));
}

function focusDocument(doc) {
  const item = doc.container.parent;
  const stack = item && item.parentItem;
  if (stack && typeof stack.setActiveComponentItem === 'function') {
    stack.setActiveComponentItem(item, true);
  }
  setActiveDocument(doc.path);
}

function openFile(filePath) {
  const path = normalizePath(filePath);
  const existing = openDocuments.get(path);
  if (existing) {
    focusDocument(existing);
    return existing;
  }
  const stack = findEditorStack();
  if (!stack) {
    setStatus('Editor area is unavailable', 'error');
    return null;
  }
  stack.addComponent('editor', { path }, basename(path));
  const doc = openDocuments.get(path) || null;
  if (doc) setActiveDocument(path);
  return doc;
}

function findEditorStack() {
  if (context.mobileEditorStack) return context.mobileEditorStack;
  const layout = context.layout;
  if (!layout || !layout.rootItem) return null;
  let found = null;
  const visit = (item) => {
    if (found) return;
    if (item.isStack && item.id === 'editorStack') {
      found = item;
      return;
    }
    (item.contentItems || []).forEach(visit);
  };
  visit(layout.rootItem);
  if (found) return found;
  // The tagged stack disappeared (should not happen while the welcome tab is
  // pinned) — fall back to the stack that holds any open editor.
  const anyDoc = openDocuments.values().next().value;
  if (anyDoc) {
    const item = anyDoc.container.parent;
    if (item && item.parentItem && item.parentItem.isStack) return item.parentItem;
  }
  return null;
}

/**
 * GoldenLayout factory for `editor` components.
 */
function createEditorComponent(container, state) {
  const path = normalizePath(state && state.path);
  const host = document.createElement('div');
  host.className = 'ide-editor-host';
  container.element.appendChild(host);

  const doc = {
    path,
    container,
    editor: null,
    dirty: false,
    readOnly: false,
    kind: isClassFile(path) ? 'class' : 'text',
  };
  openDocuments.set(path, doc);
  container.setTitle(basename(path));

  if (doc.kind === 'class') {
    buildClassViewer(doc, host);
  } else {
    buildTextEditor(doc, host);
  }

  container.on('resize', () => {
    if (doc.editor) doc.editor.resize();
  });
  container.on('show', () => {
    setActiveDocument(path);
    if (doc.editor) doc.editor.resize();
  });
  container.on('destroy', () => {
    if (doc.editor) doc.editor.destroy();
    openDocuments.delete(doc.path);
    if (activeDocumentPath === doc.path) activeDocumentPath = null;
  });
  container.element.addEventListener('mousedown', () => setActiveDocument(doc.path));
}

function createAce(host, { readOnly = false, mode = 'ace/mode/text', value = '' }) {
  const aceHost = document.createElement('div');
  aceHost.className = 'ide-editor-ace';
  host.appendChild(aceHost);
  const editor = window.ace.edit(aceHost);
  editor.setTheme('ace/theme/monokai');
  editor.session.setMode(mode);
  editor.session.setUseWorker(false);
  editor.setReadOnly(readOnly);
  editor.setOptions({ fontSize: '13px', showPrintMargin: false });
  editor.setValue(value, -1);
  return editor;
}

function buildTextEditor(doc, host) {
  let text = '';
  try {
    text = context.workspace.readFileSync(doc.path, 'utf8');
  } catch (error) {
    text = '';
  }
  doc.editor = createAce(host, { mode: aceModeFor(doc.path), value: String(text) });
  doc.editor.session.on('change', () => {
    if (!doc.suppressChange) markDirty(doc, true);
  });
  doc.editor.commands.addCommand({
    name: 'saveDocument',
    bindKey: { win: 'Ctrl-S', mac: 'Command-S' },
    exec: () => saveDocument(doc),
  });
}

function buildClassViewer(doc, host) {
  doc.readOnly = true;
  const banner = document.createElement('div');
  banner.className = 'ide-editor-banner';
  banner.append('Compiled class (read-only disassembly view).');

  const actions = require('./actions');
  const mkButton = (label, handler) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      Promise.resolve(handler()).catch((error) => setStatus(error.message, 'error'));
    });
    banner.appendChild(button);
    return button;
  };
  mkButton('Disassemble → .j', () => actions.disassembleClassFile(doc.path));
  mkButton('Decompile → .java', () => actions.decompileClassFile(doc.path));
  mkButton('Load into JVM', () => actions.loadClassFileIntoJvm(doc.path));
  mkButton('▶ Run', () => actions.runPath(doc.path));
  host.appendChild(banner);

  let text;
  try {
    const bytes = context.workspace.map.get(doc.path);
    text = window.jvmDebug.getClassDisassembly(bytes);
  } catch (error) {
    text = `// Failed to disassemble ${doc.path}\n// ${error.message}`;
  }
  doc.editor = createAce(host, { readOnly: true, value: text });
}

/** Reload a class viewer after its backing .class changed on disk. */
function reloadClassViewer(filePath) {
  const doc = getDocument(filePath);
  if (!doc || doc.kind !== 'class' || !doc.editor) return;
  try {
    const bytes = context.workspace.map.get(doc.path);
    doc.editor.setValue(window.jvmDebug.getClassDisassembly(bytes), -1);
  } catch (error) {
    logLine(`Failed to refresh ${filePath}: ${error.message}`, 'warning');
  }
}

function saveDocument(doc) {
  if (!doc || doc.readOnly) return false;
  const content = doc.editor.getValue();
  context.workspace.writeFileSync(doc.path, content);
  markDirty(doc, false);
  setStatus(`Saved ${doc.path}`, 'success');
  context.refreshTree();
  return true;
}

function saveActiveDocument() {
  const doc = getActiveDocument();
  if (!doc) {
    setStatus('No active editor to save', 'error');
    return false;
  }
  return saveDocument(doc);
}

/** Persist an open (possibly dirty) text document before compiling/running. */
function flushDocument(filePath) {
  const doc = getDocument(filePath);
  if (doc && !doc.readOnly && doc.dirty) saveDocument(doc);
}

function closeDocumentsUnder(pathPrefix) {
  const prefix = normalizePath(pathPrefix);
  for (const doc of Array.from(openDocuments.values())) {
    if (doc.path === prefix || doc.path.startsWith(`${prefix}/`)) {
      const item = doc.container.parent;
      if (item && typeof item.remove === 'function') item.remove();
    }
  }
}

function renameOpenDocuments(oldPath, newPath) {
  const from = normalizePath(oldPath);
  const to = normalizePath(newPath);
  for (const doc of Array.from(openDocuments.values())) {
    let updated = null;
    if (doc.path === from) updated = to;
    else if (doc.path.startsWith(`${from}/`)) updated = to + doc.path.slice(from.length);
    if (updated) {
      openDocuments.delete(doc.path);
      doc.path = updated;
      openDocuments.set(updated, doc);
      doc.container.setTitle(tabTitle(doc));
      if (activeDocumentPath === from) activeDocumentPath = updated;
    }
  }
}

module.exports = {
  createEditorComponent,
  openFile,
  getDocument,
  getActiveDocument,
  saveActiveDocument,
  flushDocument,
  closeDocumentsUnder,
  renameOpenDocuments,
  reloadClassViewer,
  findEditorStack,
};
