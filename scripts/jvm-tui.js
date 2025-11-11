#!/usr/bin/env node
'use strict';

const blessed = require('blessed');
const path = require('path');
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');

async function loadWorkspace(classpath) {
  return await KrakatauWorkspace.create(classpath);
}

function buildTree(workspace) {
  const tree = {};
  Object.keys(workspace.workspaceASTs).forEach((className) => {
    const parts = className.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      node.children = node.children || {};
      node.children[part] = node.children[part] || {};
      node = node.children[part];
    }
    node.classes = node.classes || [];
    node.classes.push(className);
  });
  return tree;
}

function createScreen() {
  return blessed.screen({
    smartCSR: true,
    title: 'JVM TUI',
  });
}

function formatClassInfo(workspace, className) {
  if (!workspace.workspaceASTs[className]) {
    return `Class ${className} not found.`;
  }
  const ast = workspace.getClassAST(className);
  const cls = ast.classes[0];
  const lines = [
    `Class: ${cls.className}`,
    `Flags: ${(cls.flags || []).join(' ')}`,
    `Super: ${cls.superClassName}`,
    `Interfaces: ${(cls.interfaces || []).join(', ') || '(none)'}`,
    '',
    'Methods:',
  ];
  workspace.listMethods(className).forEach((method) => {
    const flags = method.flags ? method.flags.join(' ') : '';
    lines.push(`  ${method.identifier.memberName}${method.descriptor} ${flags}`);
  });
  lines.push('', 'Fields:');
  workspace.listFields(className).forEach((field) => {
    const flags = field.flags ? field.flags.join(' ') : '';
    lines.push(`  ${field.identifier.memberName} : ${field.descriptor} ${flags}`);
  });
  return lines.join('\n');
}

function populateTreeNodes(tree, parentNode, workspace) {
  const entries = Object.entries(tree.children || {});
  entries.sort(([a], [b]) => a.localeCompare(b));
  entries.forEach(([name, child]) => {
    const node = parentNode.addItem(name);
    populateTreeNodes(child, node, workspace);
  });
  (tree.classes || []).sort().forEach((className) => {
    const node = parentNode.addItem(className);
    node.className = className;
  });
}

async function main() {
  const args = process.argv.slice(2);
  let classpath = ['sources'];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--classpath' || args[i] === '-cp') {
      classpath = args[++i].split(path.delimiter);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node scripts/jvm-tui.js [--classpath dir]');
      process.exit(0);
    }
  }

  const workspace = await loadWorkspace(classpath);
  const screen = createScreen();

  const treeBox = blessed.list({
    parent: screen,
    label: ' Classes ',
    tags: true,
    width: '30%',
    height: '100%',
    keys: true,
    vi: true,
    mouse: true,
    border: 'line',
    style: {
      selected: {
        bg: 'blue',
      },
    },
  });

  const infoBox = blessed.box({
    parent: screen,
    label: ' Details ',
    width: '70%',
    height: '100%',
    left: '30%',
    tags: false,
    border: 'line',
    scrollable: true,
    keys: true,
    vi: true,
    mouse: true,
    alwaysScroll: true,
    scrollbar: {
      ch: ' ',
      inverse: true,
    },
  });

  const rootNode = {
    addItem(name) {
      const item = {
        name,
        items: [],
        addItem(n) {
          const childIdx = this.items.length;
          const child = {
            name,
            items: [],
            addItem: this.addItem,
          };
          this.items.push(child);
          return child;
        },
      };
      this.items.push(item);
      return item;
    },
    items: [],
  };

  populateTreeNodes(buildTree(workspace), rootNode, workspace);

  const flatItems = [];
  function flatten(node, depth = 0) {
    node.items.forEach((child) => {
      flatItems.push({ display: `${'  '.repeat(depth)}${child.name}`, className: child.className });
      if (child.items.length) {
        flatten(child, depth + 1);
      }
    });
  }
  flatten(rootNode);
  flatItems.forEach((item) => treeBox.addItem(item.display));

  treeBox.on('select', (_, index) => {
    const item = flatItems[index];
    if (item && item.className) {
      infoBox.setContent(formatClassInfo(workspace, item.className));
      screen.render();
    }
  });

  screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

  treeBox.focus();
  screen.render();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
