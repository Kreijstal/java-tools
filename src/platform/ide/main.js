'use strict';

// Java Tools IDE shell: GoldenLayout-based layout with a real file explorer,
// per-file editor tabs, and javac-style compile placement. The JVM runtime,
// terminal bridge, and debugger plumbing come from browser-ui-enhancements.js
// (loaded before this bundle); this module only provides the IDE presentation
// and drives those APIs.

const { GoldenLayout } = require('golden-layout');
const context = require('./context');
const mobile = require('./mobileLayout');
const documents = require('./documents');
const explorer = require('./explorer');
const actions = require('./actions');
const {
  byId,
  parentPath,
  extensionOf,
  setStatus,
  logLine,
  downloadBytes,
  basename,
} = require('./util');

const DEFAULT_MAIN = '/src/Main.java';

// Last class loaded into the JVM (via loadVirtualClass); used as the Run
// fallback when no runnable file is focused.
let lastLoadedClassPath = null;
window.addEventListener('javatools:class-loaded', (event) => {
  lastLoadedClassPath = (event.detail && event.detail.classPath) || lastLoadedClassPath;
});

// Source-level debugging: whenever the debugger pauses on a PC that maps to a
// source line (LineNumberTable), highlight that line in the backing .java.
window.addEventListener('javatools:debug-state', (event) => {
  const state = event.detail || {};
  if (
    state.executionState === 'paused'
    && typeof state.sourceLine === 'number'
    && state.sourceFile
    && state.className
  ) {
    const sourcePath = actions.findSourceFileForClass(state.className, state.sourceFile);
    if (sourcePath) {
      documents.highlightSourceLine(sourcePath, state.sourceLine);
      return;
    }
  }
  if (state.executionState !== 'paused') {
    documents.clearSourceHighlight();
  }
});

// ---------- Layout ----------

const panelHandles = new Map(); // panel key -> ComponentItem

function panelFactory(container, state) {
  const key = state && state.panel;
  const node = byId(`panel-${key}`);
  if (!node) {
    container.element.textContent = `Unknown panel: ${key}`;
    return;
  }
  container.element.appendChild(node);
  panelHandles.set(key, container.parent);

  const onShownOrResized = () => {
    if (key === 'terminal' && typeof window.fitJvmTerminal === 'function') {
      window.fitJvmTerminal();
    }
    if (key === 'bytecode' && window.aceEditor) {
      window.aceEditor.resize();
    }
  };
  container.on('resize', onShownOrResized);
  container.on('show', () => setTimeout(onShownOrResized, 0));
}

function welcomeFactory(container) {
  const host = document.createElement('div');
  host.style.cssText = 'padding:24px;max-width:640px;line-height:1.6;';
  host.innerHTML = `
    <h2 style="color:#569cd6;margin-top:0;">Welcome</h2>
    <p>This is the Java Tools IDE: a browser workspace with a real file tree,
    an in-browser JVM, compiler, assembler, and decompiler.</p>
    <ul>
      <li><b>Explorer</b> (left): browse, create, rename, and delete files.
        Right-click for compile/run/disassemble actions.</li>
      <li><b>Compiling</b> <code>Foo.java</code> puts <code>Foo.class</code>
        next to it, like <code>javac</code>.</li>
      <li><code>.java</code>, <code>.j</code>, and <code>.class</code> are
        ordinary distinct files — disassembling or decompiling a class writes a
        real sibling file.</li>
      <li><b>Terminal</b> (bottom): program input/output via xterm.js.</li>
      <li>Prefer the old page? <a href="./classic.html">Classic workbench</a>.</li>
    </ul>`;
  container.element.appendChild(host);
}

function layoutConfig() {
  const bottomPanel = (panel, title) => ({
    type: 'component',
    componentType: 'panel',
    componentState: { panel },
    title,
    isClosable: false,
  });
  return {
    settings: { showPopoutIcon: false },
    dimensions: { headerHeight: 30, borderWidth: 5 },
    root: {
      type: 'row',
      content: [
        {
          type: 'component',
          componentType: 'panel',
          componentState: { panel: 'explorer' },
          title: 'Files',
          isClosable: false,
          width: 16,
        },
        {
          type: 'column',
          width: 84,
          content: [
            {
              type: 'stack',
              id: 'editorStack',
              height: 62,
              content: [
                {
                  type: 'component',
                  componentType: 'welcome',
                  title: 'Welcome',
                  isClosable: false,
                },
              ],
            },
            {
              type: 'stack',
              id: 'bottomStack',
              height: 38,
              content: [
                bottomPanel('terminal', 'Terminal'),
                bottomPanel('output', 'Output'),
                bottomPanel('display', 'Display'),
                bottomPanel('debug', 'Debug'),
                bottomPanel('bytecode', 'Bytecode'),
              ],
            },
          ],
        },
      ],
    },
  };
}

function reveal(panelKey) {
  if (context.mobileLayout) {
    context.mobileLayout.reveal(panelKey);
    if (panelKey === 'terminal' && typeof window.focusJvmTerminal === 'function') {
      setTimeout(() => window.focusJvmTerminal(), 0);
    }
    return;
  }
  const item = panelHandles.get(panelKey);
  if (!item || !item.parentItem || typeof item.parentItem.setActiveComponentItem !== 'function') {
    return;
  }
  item.parentItem.setActiveComponentItem(item, false);
  if (panelKey === 'terminal' && typeof window.fitJvmTerminal === 'function') {
    setTimeout(() => {
      window.fitJvmTerminal();
      if (typeof window.focusJvmTerminal === 'function') window.focusJvmTerminal();
    }, 0);
  }
}

function initLayout() {
  if (mobile.isMobile()) {
    mobile.initMobileLayout();
    return;
  }
  const layout = new GoldenLayout(byId('gl-root'));
  layout.resizeWithContainerAutomatically = true;
  layout.registerComponentFactoryFunction('panel', panelFactory);
  layout.registerComponentFactoryFunction('welcome', welcomeFactory);
  layout.registerComponentFactoryFunction('editor', documents.createEditorComponent);
  layout.loadLayout(layoutConfig());
  context.layout = layout;
}

// ---------- Toolbar ----------

function activeFileOfKind(extensions) {
  const doc = documents.getActiveDocument();
  if (doc && extensions.includes(extensionOf(doc.path))) return doc.path;
  return null;
}

function wireMenus() {
  const menus = Array.from(document.querySelectorAll('.ide-menu'));
  for (const menu of menus) {
    const button = menu.querySelector('[data-menu-button]');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = menu.classList.contains('open');
      menus.forEach((other) => other.classList.remove('open'));
      if (!wasOpen) menu.classList.add('open');
    });
  }
  document.addEventListener('click', () => {
    menus.forEach((menu) => menu.classList.remove('open'));
  });
}

function guarded(handler) {
  return () => {
    Promise.resolve()
      .then(handler)
      .catch((error) => {
        setStatus(error.message, 'error');
        logLine(error.stack || error.message, 'error');
      });
  };
}

function activeDirectory() {
  const doc = documents.getActiveDocument();
  return doc ? parentPath(doc.path) : '/src';
}

function compileActive() {
  const javaPath = activeFileOfKind(['java']);
  if (javaPath) return actions.compileJavaFile(javaPath);
  const jasminPath = activeFileOfKind(['j']);
  if (jasminPath) return actions.assembleJasminFile(jasminPath);
  setStatus('Open a .java or .j file to compile', 'error');
  return null;
}

async function runActive({ debug = false } = {}) {
  const doc = documents.getActiveDocument();
  if (doc && ['java', 'j', 'class'].includes(extensionOf(doc.path))) {
    await actions.runPath(doc.path, { debug });
    return;
  }
  // No runnable editor focused — fall back to whatever class is loaded in the
  // JVM (e.g. a sample selected from the toolbar).
  if (lastLoadedClassPath) {
    if (debug) {
      reveal('debug');
      await window.startDebugging();
    } else {
      reveal('terminal');
      await window.runProgram();
    }
    return;
  }
  const select = byId('sampleClassSelect');
  if (select && select.value) {
    await window.loadVirtualClass(select.value);
    if (debug) {
      reveal('debug');
      await window.startDebugging();
    } else {
      reveal('terminal');
      await window.runProgram();
    }
    return;
  }
  setStatus('Nothing to run — open a .java/.j/.class file or pick a sample', 'error');
}

function wireToolbar() {
  wireMenus();

  byId('menuNewFile').addEventListener('click', guarded(() => explorer.createFile(activeDirectory())));
  byId('menuNewFolder').addEventListener('click', guarded(() => explorer.createFolder('/')));
  byId('menuOpenDisk').addEventListener('click', guarded(() => explorer.uploadInto('/')));
  byId('menuSave').addEventListener('click', guarded(() => documents.saveActiveDocument()));
  byId('menuDownload').addEventListener('click', guarded(() => {
    const doc = documents.getActiveDocument();
    if (!doc) throw new Error('No active editor');
    const bytes = context.workspace.map.get(doc.path);
    if (bytes === undefined) throw new Error(`Cannot read ${doc.path}`);
    downloadBytes(basename(doc.path), bytes);
  }));
  byId('menuCompile').addEventListener('click', guarded(compileActive));
  byId('menuAssemble').addEventListener('click', guarded(() => {
    const jasminPath = activeFileOfKind(['j']);
    if (!jasminPath) throw new Error('Open a .j file to assemble');
    return actions.assembleJasminFile(jasminPath);
  }));

  byId('runBtn').addEventListener('click', guarded(() => runActive()));
  byId('debugBtn').addEventListener('click', guarded(() => runActive({ debug: true })));

  byId('loadSampleBtn').addEventListener('click', guarded(async () => {
    const select = byId('sampleClassSelect');
    if (!select.value) throw new Error('Pick a sample first');
    await window.loadVirtualClass(select.value);
    reveal('bytecode');
    // Lazy compilation just wrote the sample's .java (and dependencies) into
    // /samples of the shared workspace: show them and open the source.
    explorer.refreshTree();
    const sourcePath = typeof window.findSampleSourcePath === 'function'
      ? window.findSampleSourcePath(select.value)
      : null;
    if (sourcePath && context.workspace.existsSync(sourcePath)) {
      documents.openFile(sourcePath);
    }
  }));

  // Explorer panel toolbar
  byId('explorerNewFileBtn').addEventListener('click', guarded(() => explorer.createFile(activeDirectory())));
  byId('explorerNewFolderBtn').addEventListener('click', guarded(() => explorer.createFolder('/')));
  byId('explorerUploadBtn').addEventListener('click', guarded(() => explorer.uploadInto('/')));
  byId('explorerRefreshBtn').addEventListener('click', guarded(() => explorer.refreshTree()));

  // Output panel toolbar
  byId('outputClearBtn').addEventListener('click', guarded(() => window.clearOutput()));

  // Debug panel controls: thin wrappers over the runtime layer's globals.
  const debugCall = (name) => guarded(() => {
    if (typeof window[name] !== 'function') throw new Error(`${name} is not ready yet`);
    return window[name]();
  });
  byId('pauseBtn').addEventListener('click', debugCall('pauseExecution'));
  byId('continueBtn').addEventListener('click', debugCall('continue_'));
  byId('stepIntoBtn').addEventListener('click', debugCall('stepInto'));
  byId('stepOverBtn').addEventListener('click', debugCall('stepOver'));
  byId('stepOutBtn').addEventListener('click', debugCall('stepOut'));
  byId('stepInstructionBtn').addEventListener('click', debugCall('stepInstruction'));
  byId('finishBtn').addEventListener('click', debugCall('finish'));
  byId('rewindBtn').addEventListener('click', debugCall('rewind'));
  byId('setBreakpointBtn').addEventListener('click', debugCall('setBreakpoint'));
  byId('clearBreakpointsBtn').addEventListener('click', debugCall('clearAllBreakpoints'));

  document.addEventListener('keydown', (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier) return;
    if (event.key === 's') {
      event.preventDefault();
      guarded(() => documents.saveActiveDocument())();
    } else if (event.key === 'b') {
      event.preventDefault();
      guarded(compileActive)();
    }
  });
}

// ---------- Boot ----------

function waitForJvmReady(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (window.jvmDebug && window.jvmDebug.isInitialized()) {
        resolve(window.jvmDebug);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('JVM runtime did not become ready'));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function bootWorkspace() {
  setStatus('Starting JVM runtime…', 'info');
  const jvmDebug = await waitForJvmReady();
  const workspace = await jvmDebug.ensureWorkspace();
  jvmDebug.fileProvider.addClasspathRoot('/samples');
  context.workspace = workspace;

  if (!workspace.existsSync(DEFAULT_MAIN)) {
    workspace.mkdirSync('/src', { recursive: true });
    workspace.writeFileSync(DEFAULT_MAIN, `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello from the Java Tools IDE!");
    }
}
`);
  }
  explorer.refreshTree();
  documents.openFile(DEFAULT_MAIN);
  setStatus('Ready', 'success');
  window.dispatchEvent(new CustomEvent('javatools:ide-ready'));
}

function boot() {
  context.reveal = reveal;
  context.refreshTree = () => explorer.refreshTree();
  context.openFile = (path) => documents.openFile(path);

  initLayout();
  wireToolbar();
  explorer.refreshTree();

  bootWorkspace().catch((error) => {
    setStatus(error.message, 'error');
    logLine(error.stack || error.message, 'error');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Exposed for tests and console poking.
window.javaToolsIde = {
  context,
  actions,
  documents,
  explorer,
  reveal,
};
