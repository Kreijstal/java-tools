'use strict';

// Mobile fallback layout. GoldenLayout's drag-and-drop docking is unusable on
// touch screens, so small/coarse-pointer devices get a single-view UI: a
// horizontal view-switcher bar (Files, Editor, Terminal, …) with one
// fullscreen view at a time. Editor tabs get their own strip inside the
// Editor view. The documents/explorer/actions modules are shared with the
// desktop layout through a small GoldenLayout-compatible adapter.

const context = require('./context');
const { byId } = require('./util');

const PANEL_VIEWS = [
  ['explorer', 'Files'],
  ['editor', 'Editor'],
  ['terminal', 'Terminal'],
  ['output', 'Output'],
  ['display', 'Display'],
  ['debug', 'Debug'],
  ['bytecode', 'Bytecode'],
];

function isMobile() {
  if (window.innerWidth <= 768) return true;
  return Boolean(
    window.matchMedia
    && window.matchMedia('(pointer: coarse)').matches
    && window.innerWidth <= 1024,
  );
}

/** Minimal stand-in for a GoldenLayout ComponentContainer. */
function createContainerAdapter(element) {
  const listeners = new Map();
  const adapter = {
    element,
    parent: null, // set to the item adapter after creation
    setTitle(title) {
      if (adapter.parent && adapter.parent.tabButton) {
        adapter.parent.tabLabel.textContent = title;
      }
    },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
    },
    emit(event, ...args) {
      for (const callback of listeners.get(event) || []) callback(...args);
    },
  };
  return adapter;
}

class MobileLayout {
  constructor(rootElement) {
    this.root = rootElement;
    this.root.classList.add('ide-mobile-root');
    this.views = new Map();
    this.activeView = null;

    this.viewBar = document.createElement('div');
    this.viewBar.className = 'ide-mobile-viewbar';
    this.root.appendChild(this.viewBar);

    this.viewHost = document.createElement('div');
    this.viewHost.className = 'ide-mobile-viewhost';
    this.root.appendChild(this.viewHost);

    for (const [key, label] of PANEL_VIEWS) {
      this.addView(key, label);
    }
    this.buildEditorView();
    this.showView('explorer');
  }

  addView(key, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.view = key;
    button.addEventListener('click', () => this.showView(key));
    this.viewBar.appendChild(button);

    const view = document.createElement('div');
    view.className = 'ide-mobile-view';
    view.dataset.view = key;
    this.viewHost.appendChild(view);

    if (key !== 'editor') {
      const panelNode = byId(`panel-${key}`);
      if (panelNode) view.appendChild(panelNode);
    }
    this.views.set(key, { button, view });
  }

  showView(key) {
    if (!this.views.has(key)) return;
    this.activeView = key;
    for (const [viewKey, { button, view }] of this.views) {
      const active = viewKey === key;
      button.classList.toggle('active', active);
      view.classList.toggle('active', active);
    }
    if (key === 'terminal' && typeof window.fitJvmTerminal === 'function') {
      setTimeout(() => window.fitJvmTerminal(), 0);
    }
    if (key === 'bytecode' && window.aceEditor) {
      setTimeout(() => window.aceEditor.resize(), 0);
    }
    if (key === 'editor' && this.activeEditorItem && this.activeEditorItem.container) {
      const item = this.activeEditorItem;
      setTimeout(() => item.container.emit('resize'), 0);
    }
  }

  buildEditorView() {
    const { view } = this.views.get('editor');
    this.editorTabBar = document.createElement('div');
    this.editorTabBar.className = 'ide-mobile-editortabs';
    view.appendChild(this.editorTabBar);
    this.editorHost = document.createElement('div');
    this.editorHost.className = 'ide-mobile-editorhost';
    view.appendChild(this.editorHost);
    this.editorItems = [];
    this.activeEditorItem = null;
  }

  /** GoldenLayout-Stack-compatible surface used by documents.openFile. */
  get editorStack() {
    const layout = this;
    return {
      isStack: true,
      addComponent(componentType, state, title) {
        return layout.addEditor(state, title);
      },
      setActiveComponentItem(item) {
        layout.activateEditor(item);
        layout.showView('editor');
      },
    };
  }

  addEditor(state, title) {
    const element = document.createElement('div');
    element.className = 'ide-mobile-editor';
    this.editorHost.appendChild(element);

    const container = createContainerAdapter(element);
    const item = {
      container,
      parentItem: this.editorStack,
      tabButton: null,
      tabLabel: null,
      remove() {
        container.emit('destroy');
      },
    };
    container.parent = item;

    const tab = document.createElement('span');
    tab.className = 'ide-mobile-editortab';
    const label = document.createElement('button');
    label.type = 'button';
    label.textContent = title;
    label.addEventListener('click', () => {
      this.activateEditor(item);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      item.remove();
    });
    tab.append(label, close);
    this.editorTabBar.appendChild(tab);
    item.tabButton = tab;
    item.tabLabel = label;

    container.on('destroy', () => {
      tab.remove();
      element.remove();
      this.editorItems = this.editorItems.filter((other) => other !== item);
      if (this.activeEditorItem === item) {
        this.activeEditorItem = null;
        const fallback = this.editorItems[this.editorItems.length - 1];
        if (fallback) this.activateEditor(fallback);
      }
    });

    this.editorItems.push(item);

    // Run the shared editor factory against the adapter.
    const documents = require('./documents');
    documents.createEditorComponent(container, state);
    this.activateEditor(item);
    this.showView('editor');
    return item;
  }

  activateEditor(item) {
    this.activeEditorItem = item;
    for (const other of this.editorItems) {
      const active = other === item;
      other.container.element.classList.toggle('active', active);
      other.tabButton.classList.toggle('active', active);
      if (active) other.container.emit('show');
    }
  }

  reveal(panelKey) {
    this.showView(panelKey === 'editor' ? 'editor' : panelKey);
  }
}

function initMobileLayout() {
  const layout = new MobileLayout(byId('gl-root'));
  document.body.classList.add('ide-mobile');
  context.mobileLayout = layout;
  context.mobileEditorStack = layout.editorStack;
  return layout;
}

module.exports = {
  isMobile,
  initMobileLayout,
};
