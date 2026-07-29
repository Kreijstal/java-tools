'use strict';

const context = require('./context');
const {
  byId,
  basename,
  parentPath,
  normalizePath,
  joinPath,
  extensionOf,
  setStatus,
  logLine,
  promptText,
  downloadBytes,
} = require('./util');

// Directories the user has expanded. Everything else renders collapsed.
const expandedDirs = new Set(['/', '/src', '/samples']);

const FILE_ICONS = {
  java: '☕',
  j: '⚙',
  class: '📦',
  jar: '🗜',
  zip: '🗜',
  txt: '📄',
  md: '📄',
  json: '📄',
};

function fileIcon(name) {
  return FILE_ICONS[extensionOf(name)] || '📄';
}

function listDirectory(dirPath) {
  const workspace = context.workspace;
  const entries = workspace.readdirSync(dirPath, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    (entry.isDirectory() ? dirs : files).push(entry.name);
  }
  const byName = (a, b) => a.localeCompare(b);
  return {
    dirs: dirs.sort(byName),
    files: files.sort(byName),
  };
}

function refreshTree() {
  const tree = byId('explorerTree');
  if (!tree) return;
  tree.innerHTML = '';
  if (!context.workspace) {
    const empty = document.createElement('li');
    empty.className = 'explorer-empty';
    empty.textContent = 'Workspace is booting…';
    tree.appendChild(empty);
    return;
  }
  renderDirectoryInto(tree, '/', 0);
  if (!tree.children.length) {
    const empty = document.createElement('li');
    empty.className = 'explorer-empty';
    empty.textContent = 'Workspace is empty. Create a file to get started.';
    tree.appendChild(empty);
  }
}

function renderDirectoryInto(listElement, dirPath, depth) {
  let listing;
  try {
    listing = listDirectory(dirPath);
  } catch (error) {
    logLine(`Cannot read ${dirPath}: ${error.message}`, 'warning');
    return;
  }
  for (const name of listing.dirs) {
    listElement.appendChild(renderDirectory(joinPath(dirPath, name), depth));
  }
  for (const name of listing.files) {
    listElement.appendChild(renderFile(joinPath(dirPath, name), depth));
  }
}

function makeRow(depth) {
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = `${depth * 14 + 6}px`;
  return row;
}

function renderDirectory(dirPath, depth) {
  const li = document.createElement('li');
  const row = makeRow(depth);
  const expanded = expandedDirs.has(dirPath);

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';
  toggle.textContent = expanded ? '▼' : '▶';

  const icon = document.createElement('span');
  icon.textContent = expanded ? '📂' : '📁';

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = basename(dirPath);

  row.append(toggle, icon, name);
  row.dataset.path = dirPath;
  row.dataset.kind = 'dir';
  li.appendChild(row);

  const children = document.createElement('ul');
  if (expanded) renderDirectoryInto(children, dirPath, depth + 1);
  li.appendChild(children);

  row.addEventListener('click', () => {
    if (expandedDirs.has(dirPath)) expandedDirs.delete(dirPath);
    else expandedDirs.add(dirPath);
    refreshTree();
  });
  row.addEventListener('contextmenu', (event) => showContextMenu(event, dirPath, 'dir'));
  return li;
}

function renderFile(filePath, depth) {
  const li = document.createElement('li');
  const row = makeRow(depth);

  const spacer = document.createElement('span');
  spacer.className = 'tree-toggle';

  const icon = document.createElement('span');
  icon.textContent = fileIcon(filePath);

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = basename(filePath);

  row.append(spacer, icon, name);
  row.dataset.path = filePath;
  row.dataset.kind = 'file';
  li.appendChild(row);

  row.addEventListener('click', () => context.openFile(filePath));
  row.addEventListener('contextmenu', (event) => showContextMenu(event, filePath, 'file'));
  return li;
}

// ---------- Context menu ----------

function hideContextMenu() {
  const menu = byId('ideContextMenu');
  menu.style.display = 'none';
  menu.innerHTML = '';
}

function showContextMenu(event, targetPath, kind) {
  event.preventDefault();
  event.stopPropagation();
  const menu = byId('ideContextMenu');
  menu.innerHTML = '';

  const addItem = (label, handler) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      hideContextMenu();
      Promise.resolve(handler()).catch((error) => setStatus(error.message, 'error'));
    });
    menu.appendChild(button);
  };
  const addSeparator = () => menu.appendChild(document.createElement('hr'));

  const actions = require('./actions');
  const ext = extensionOf(targetPath);

  if (kind === 'dir') {
    addItem('New File…', () => createFile(targetPath));
    addItem('New Folder…', () => createFolder(targetPath));
    addItem('Upload here…', () => uploadInto(targetPath));
    addSeparator();
    addItem('Rename…', () => renameEntry(targetPath));
    addItem('Delete', () => deleteEntry(targetPath, true));
  } else {
    addItem('Open', () => context.openFile(targetPath));
    if (ext === 'java') {
      addSeparator();
      addItem('Compile', () => actions.compileJavaFile(targetPath));
      addItem('▶ Run', () => actions.runPath(targetPath));
      addItem('🐞 Debug', () => actions.debugPath(targetPath));
    } else if (ext === 'j') {
      addSeparator();
      addItem('Assemble → .class', () => actions.assembleJasminFile(targetPath));
      addItem('▶ Run', () => actions.runPath(targetPath));
    } else if (ext === 'class') {
      addSeparator();
      addItem('Disassemble → .j', () => actions.disassembleClassFile(targetPath));
      addItem('Decompile → .java', () => actions.decompileClassFile(targetPath));
      addItem('Load into JVM', () => actions.loadClassFileIntoJvm(targetPath));
      addItem('▶ Run', () => actions.runPath(targetPath));
      addItem('🐞 Debug', () => actions.debugPath(targetPath));
    }
    addSeparator();
    addItem('Rename…', () => renameEntry(targetPath));
    addItem('Delete', () => deleteEntry(targetPath, false));
    addItem('Download', () => downloadEntry(targetPath));
  }

  menu.style.display = 'block';
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 4)}px`;
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', (event) => {
  if (!event.target.closest('#explorerTree')) hideContextMenu();
});

// ---------- File operations ----------

const JAVA_TEMPLATE = (className) => `public class ${className} {
    public static void main(String[] args) {
        System.out.println("Hello from ${className}!");
    }
}
`;

async function createFile(dirPath = '/src') {
  const name = await promptText({
    title: `New file in ${dirPath}`,
    placeholder: 'Example.java',
    hint: 'Subdirectories are created as needed, e.g. model/Point.java',
  });
  if (!name) return null;
  const filePath = joinPath(dirPath, name);
  if (context.workspace.existsSync(filePath)) {
    context.openFile(filePath);
    return filePath;
  }
  const parent = parentPath(filePath);
  context.workspace.mkdirSync(parent, { recursive: true });
  let content = '';
  if (extensionOf(filePath) === 'java') {
    content = JAVA_TEMPLATE(basename(filePath).replace(/\.java$/, ''));
  }
  context.workspace.writeFileSync(filePath, content);
  expandAncestors(filePath);
  refreshTree();
  context.openFile(filePath);
  setStatus(`Created ${filePath}`, 'success');
  return filePath;
}

async function createFolder(dirPath = '/') {
  const name = await promptText({
    title: `New folder in ${dirPath}`,
    placeholder: 'src/model',
    hint: 'Nested paths are allowed',
  });
  if (!name) return null;
  const folderPath = joinPath(dirPath, name);
  context.workspace.mkdirSync(folderPath, { recursive: true });
  expandAncestors(joinPath(folderPath, 'x'));
  refreshTree();
  setStatus(`Created folder ${folderPath}`, 'success');
  return folderPath;
}

function expandAncestors(filePath) {
  let current = parentPath(filePath);
  while (true) {
    expandedDirs.add(current);
    if (current === '/') break;
    current = parentPath(current);
  }
}

async function renameEntry(targetPath) {
  const documents = require('./documents');
  const newName = await promptText({
    title: `Rename ${targetPath}`,
    value: basename(targetPath),
  });
  if (!newName || newName === basename(targetPath)) return;
  const newPath = joinPath(parentPath(targetPath), newName);
  if (context.workspace.existsSync(newPath)) {
    setStatus(`${newPath} already exists`, 'error');
    return;
  }
  context.workspace.renameSync(targetPath, newPath);
  documents.renameOpenDocuments(targetPath, newPath);
  refreshTree();
  setStatus(`Renamed to ${newPath}`, 'success');
}

async function deleteEntry(targetPath, isDirectory) {
  const documents = require('./documents');
  documents.closeDocumentsUnder(targetPath);
  context.workspace.rmSync(targetPath, { recursive: isDirectory, force: true });
  refreshTree();
  setStatus(`Deleted ${targetPath}`, 'success');
}

function downloadEntry(targetPath) {
  const bytes = context.workspace.map.get(targetPath);
  if (bytes === undefined) {
    setStatus(`Cannot read ${targetPath}`, 'error');
    return;
  }
  downloadBytes(basename(targetPath), bytes);
}

function uploadInto(dirPath = '/') {
  const input = byId('ideUploadInput');
  const onChange = async () => {
    input.removeEventListener('change', onChange);
    const files = Array.from(input.files || []);
    input.value = '';
    for (const file of files) {
      const buffer = new Uint8Array(await file.arrayBuffer());
      if (/\.(jar|zip)$/i.test(file.name)) {
        // Extract archives onto the classpath so their classes are runnable,
        // and keep the archive itself out of the tree.
        const extracted = await window.jvmDebug.fileProvider.loadJarArchive(buffer, file.name);
        setStatus(`Extracted ${file.name} (${extracted.length} entries)`, 'success');
      } else {
        const filePath = joinPath(dirPath, file.name);
        context.workspace.mkdirSync(parentPath(filePath), { recursive: true });
        context.workspace.writeFileSync(filePath, buffer);
        setStatus(`Uploaded ${filePath}`, 'success');
      }
    }
    expandedDirs.add(normalizePath(dirPath));
    refreshTree();
  };
  input.addEventListener('change', onChange);
  input.click();
}

module.exports = {
  refreshTree,
  createFile,
  createFolder,
  uploadInto,
  expandAncestors,
};
