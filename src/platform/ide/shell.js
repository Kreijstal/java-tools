// Debug shell: evaluate Java against the live JVM and print variables.
//
// The evaluator (src/debug/evaluator.js) compiles a snippet in memory and runs
// it inside the JVM that is already loaded, so expressions observe the real
// heap rather than a fresh instance.  Compilation pulls the Java frontend as a
// separate chunk on first use, so opening this panel costs nothing until a
// line is actually submitted.

const { byId } = require('./util');

const HELP = [
  'Debug shell — Java expressions run against the live JVM.',
  '',
  '  <expression>     evaluate and print, e.g.  2 + 3 * 4',
  '  <statements>;    run for effect, e.g.      SomeClass.flag = true;',
  '  :locals          print locals of the paused frame',
  '  :stack           print the operand stack',
  '  :threads         list threads',
  '  :clear           clear this log',
  '  :help            this message',
  '',
  'Evaluation requires debug mode; it is enabled automatically on first use.',
].join('\n');

const history = [];
let historyIndex = 0;

function logElement() {
  return byId('shellLog');
}

function append(text, kind = 'result') {
  const log = logElement();
  if (!log) return;
  const line = document.createElement('div');
  line.className = `shell-line shell-${kind}`;
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function debugInstance() {
  const instance = window.jvmDebug;
  if (!instance) throw new Error('The JVM is not initialised yet');
  return instance;
}

function formatValue(result) {
  if (!result) return 'null';
  if (result.status === 'empty') return '';
  if (result.kind === 'statements') return 'ok';
  const type = result.type ? ` (${result.type})` : '';
  return `${result.display}${type}`;
}

// An inspected value may be a primitive, an array, or a JVM object handle.
// String() alone renders an empty array as '' and an object as [object
// Object], which reads as though the variable had no value at all.
function renderValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length ? `[${value.join(', ')}]` : '[] (empty)';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }
  return String(value);
}

function formatEntries(entries, emptyMessage) {
  if (!entries || !entries.length) return emptyMessage;
  return entries.map((entry, index) => {
    if (entry && typeof entry === 'object' &&
        (entry.name !== undefined || entry.value !== undefined)) {
      const name = entry.name !== undefined ? entry.name : index;
      const type = entry.type ? ` : ${entry.type}` : '';
      return `  [${index}] ${name}${type} = ${renderValue(entry.value)}`;
    }
    return `  [${index}] ${renderValue(entry)}`;
  }).join('\n');
}

function runCommand(command) {
  const instance = debugInstance();
  switch (command) {
    case ':help':
      return HELP;
    case ':clear': {
      const log = logElement();
      if (log) log.textContent = '';
      return '';
    }
    case ':locals':
      return formatEntries(instance.inspectLocals(), '  (no locals; is a frame paused?)');
    case ':stack':
      return formatEntries(instance.inspectStack(), '  (operand stack is empty)');
    case ':threads': {
      const threads = instance.debugController.getThreads();
      return formatEntries(threads, '  (no threads)');
    }
    default:
      return null;
  }
}

async function submit(source) {
  const text = String(source || '').trim();
  if (!text) return;
  history.push(text);
  historyIndex = history.length;
  append(`> ${text}`, 'input');

  try {
    const command = runCommand(text.toLowerCase());
    if (command !== null) {
      if (command) append(command, 'note');
      return;
    }
    const instance = debugInstance();
    // Evaluation is gated on debug mode; a shell user has already opted in by
    // typing here, so enable it rather than failing with an instruction.
    const jvm = instance.debugController && instance.debugController.jvm;
    if (jvm && jvm.debugManager && !jvm.debugManager.debugMode) {
      jvm.debugManager.enable();
      append('(debug mode enabled)', 'note');
    }
    const result = await instance.evaluate(text);
    append(formatValue(result), 'result');
  } catch (error) {
    append(String((error && error.message) || error), 'error');
  }
}

function initShell() {
  const input = byId('shellInput');
  if (!input) return;
  append(HELP, 'note');
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const value = input.value;
      input.value = '';
      submit(value);
      return;
    }
    if (event.key === 'ArrowUp' && historyIndex > 0) {
      event.preventDefault();
      historyIndex -= 1;
      input.value = history[historyIndex] || '';
    }
    if (event.key === 'ArrowDown' && historyIndex < history.length) {
      event.preventDefault();
      historyIndex += 1;
      input.value = history[historyIndex] || '';
    }
  });
  const runButton = byId('shellRunBtn');
  if (runButton) {
    runButton.addEventListener('click', () => {
      const value = input.value;
      input.value = '';
      submit(value);
    });
  }
  const clearButton = byId('shellClearBtn');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      const log = logElement();
      if (log) log.textContent = '';
    });
  }
}

module.exports = { initShell, submit };
