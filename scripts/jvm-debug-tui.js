#!/usr/bin/env node
'use strict';

// Interactive JVM debugger TUI.
//
// scripts/jvm-tui.js browses a workspace's classes but never executes them,
// and scripts/jvm-debugger.js drives execution one process invocation at a
// time through a state file.  Neither lets you sit in front of a running
// program.  This joins the two: a live DebugController with disassembly,
// locals, operand stack, call stack and threads on screen, plus a prompt that
// evaluates Java against the paused heap (src/debug/evaluator.js).

const path = require('path');
const blessed = require('blessed');
const DebugController = require('../src/debug/debugController');

const KEY_HELP = [
  'c/F5 continue', 'n/F10 step over', 's/F11 step into', 'o/F12 step out',
  'i step insn', 'f finish', 'r rewind', 'b set bp',
  ': / Enter / Tab prompt', 'q quit',
].join('  |  ');

const PROMPT_HELP = [
  'Prompt commands:',
  '  <Java expression>   evaluate against the paused heap, e.g. 2 + 3 * 4',
  '  <statements>;       run for effect',
  '  :b <where> [if <expr>]  breakpoint, optionally conditional',
  '                        e.g. :b Work.tick(int) if Work.total > 1000',
  '                        <where> is one of:',
  '                        Class.method            method entry',
  '                        Class.method(int, String)  pick an overload',
  '                        Class.method/2          pick by arity',
  '                        Class.method*           every overload',
  '                        Class.method+12         exact bytecode offset',
  '                        File.java:12            source line',
  '                        :12                     line in the current class',
  '                        12                      bare bytecode offset',
  '  :rm <pc>            remove a breakpoint',
  '  Tab                 complete a class or method name',
  '  :bp                 list breakpoints',
  '  :t <id>             select a thread',
  '  :cp                 show the classpath',
  '  :cp+ <path>         append a classpath entry',
  '  :cp- <path|index>   remove a classpath entry',
  '  :cp= <a:b:c>        replace the classpath',
  '  :help               this message',
].join('\n');

function parseArgs(argv) {
  const options = { classpath: [], className: null, args: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--classpath' || value === '-cp') {
      options.classpath.push(...String(argv[++i] || '').split(path.delimiter));
    } else if (!options.className) {
      options.className = value;
    } else {
      options.args.push(value);
    }
  }
  return options;
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/jvm-debug-tui.js [-cp <dir>] <ClassName|file.class>\n\n' +
    'Interactive JVM debugger.  Keys: ' + KEY_HELP + '\n');
}

function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `${value}L`;
  if (Array.isArray(value)) {
    return value.length ? `[${value.length}] ${value.slice(0, 6).join(', ')}` : '[]';
  }
  if (typeof value === 'object') {
    if (typeof value.type === 'string') {
      if (value.type === 'java/lang/String') return JSON.stringify(String(value.value ?? ''));
      if (value.type.startsWith('[')) return `${value.type}#${value.length || 0}`;
      return `${value.type}@${value.hashCode ?? '?'}`;
    }
    return JSON.stringify(value).slice(0, 80);
  }
  return String(value);
}

function createUi() {
  const screen = blessed.screen({ smartCSR: true, title: 'JVM Debugger' });
  const border = { type: 'line' };
  const style = { border: { fg: 'grey' }, label: { fg: 'cyan' } };

  const code = blessed.box({
    parent: screen, label: ' Disassembly ', top: 0, left: 0,
    width: '60%', height: '70%', border, style,
    scrollable: true, alwaysScroll: true, tags: true,
    scrollbar: { ch: ' ', style: { bg: 'blue' } },
  });
  const locals = blessed.box({
    parent: screen, label: ' Locals ', top: 0, left: '60%',
    width: '40%', height: '35%', border, style,
    scrollable: true, alwaysScroll: true, tags: true,
  });
  const stack = blessed.box({
    parent: screen, label: ' Operand stack ', top: '35%', left: '60%',
    width: '40%', height: '35%', border, style,
    scrollable: true, alwaysScroll: true, tags: true,
  });
  const threads = blessed.box({
    parent: screen, label: ' Threads / Call stack ', top: '70%', left: '60%',
    width: '40%', height: '27%', border, style,
    scrollable: true, alwaysScroll: true, tags: true,
  });
  const log = blessed.box({
    parent: screen, label: ' Output ', top: '70%', left: 0,
    width: '60%', height: '27%', border, style,
    scrollable: true, alwaysScroll: true, tags: true,
  });
  // Nothing else on screen says whether keystrokes go to the prompt or to the
  // single-key commands, and the two do very different things, so the gutter
  // reports which one has the keyboard.
  const gutter = blessed.box({
    parent: screen, bottom: 0, left: 0, width: 2, height: 1,
    tags: true, content: '{grey-fg}·{/grey-fg} ',
  });
  const prompt = blessed.textbox({
    parent: screen, bottom: 0, left: 2, width: '100%-2', height: 1,
    inputOnFocus: true, style: { fg: 'white' },
  });
  const status = blessed.box({
    parent: screen, bottom: 1, left: 0, width: '100%', height: 1,
    tags: true, style: { fg: 'black', bg: 'cyan' },
  });
  return { screen, code, locals, stack, threads, log, prompt, status, gutter };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.className) {
    usage();
    process.exit(1);
  }

  const controller = new DebugController({
    classpath: options.classpath.length ? options.classpath : [process.cwd()],
    jit: { enabled: false },
  });
  const ui = createUi();
  const lines = [];

  const say = (text, colour = 'white') => {
    for (const line of String(text).split('\n')) {
      lines.push(`{${colour}-fg}${line}{/}`);
    }
    while (lines.length > 500) lines.shift();
    ui.log.setContent(lines.join('\n'));
    // blessed derives the scroll height from the *rendered* box, so asking for
    // the bottom before a render silently does nothing: once the pane filled
    // up, the newest line -- the answer just asked for -- stayed below the
    // fold while stale output held the screen.
    ui.screen.render();
    ui.log.setScrollPerc(100);
    ui.screen.render();
  };

  const render = () => {
    let state;
    try {
      state = controller.getCurrentState();
    } catch (error) {
      state = null;
    }
    if (!state) {
      ui.status.setContent(' no state ');
      ui.screen.render();
      return;
    }

    // Disassembly, centred on the current instruction.
    try {
      const view = controller.getDisassemblyView();
      const text = String(view.formattedDisassembly || '');
      ui.code.setContent(text.replace(/\{/g, '{open}').replace(/\}/g, '{close}'));
      const rows = text.split('\n');
      const marked = rows.findIndex((row) => /^\s*(=>|\*)/.test(row));
      if (marked >= 0) ui.code.scrollTo(Math.max(0, marked - 5));
    } catch (error) {
      ui.code.setContent(`{grey-fg}${error.message}{/}`);
    }

    const localValues = state.locals || [];
    ui.locals.setContent(localValues.length
      ? localValues.map((value, index) =>
        `{yellow-fg}[${index}]{/} ${describe(value)}`).join('\n')
      : '{grey-fg}(none){/}');

    const stackValues = state.stack || [];
    ui.stack.setContent(stackValues.length
      ? stackValues.map((value, index) =>
        `{yellow-fg}[${index}]{/} ${describe(value)}`).join('\n')
      : '{grey-fg}(empty){/}');

    let threadText = '';
    try {
      threadText = (controller.getThreads() || []).map((thread) => {
        const current = thread.id === state.currentThreadId ? '{green-fg}*{/}' : ' ';
        return `${current} #${thread.id} ${thread.status || ''}`;
      }).join('\n');
    } catch (error) {
      threadText = `{grey-fg}${error.message}{/}`;
    }
    threadText += `\n{cyan-fg}call stack depth:{/} ${state.callStackDepth || 0}`;
    const classpath = controller.getClasspath();
    threadText += `\n{cyan-fg}classpath ({/}${classpath.length}{cyan-fg}):{/}`;
    threadText += classpath.length
      ? '\n' + classpath.map((entry, index) => `  [${index}] ${entry}`).join('\n')
      : ' (empty)';
    ui.threads.setContent(threadText);

    const method = state.method
      ? `${state.className || '?'}.${state.method.name}${state.method.descriptor}`
      : '(no frame)';
    const where = state.sourceLine
      ? ` ${state.sourceFile || ''}:${state.sourceLine}` : '';
    const breakpoints = (state.breakpoints || []).join(',') || 'none';
    ui.status.setContent(
      ` ${state.executionState}  pc=${state.pc}  ${method}${where}  bp=[${breakpoints}] `);
    ui.screen.render();
  };

  const guard = async (label, action) => {
    try {
      const result = await action();
      if (result && result.status) say(`${label}: ${result.status}`, 'grey');
    } catch (error) {
      say(`${label}: ${error.message}`, 'red');
    }
    render();
  };

  // ---------- prompt focus ----------
  const setGutter = (focused) => {
    ui.gutter.setContent(focused ? '{cyan-fg}>{/cyan-fg} ' : '{grey-fg}·{/grey-fg} ');
    ui.screen.render();
  };
  const focusPrompt = (seed = '') => {
    ui.prompt.setValue(seed);
    ui.prompt.focus();
    ui.screen.render();
  };
  ui.prompt.on('focus', () => setGutter(true));
  ui.prompt.on('blur', () => setGutter(false));

  // ---------- key bindings ----------
  const keys = {
    'C-c': () => process.exit(0),
    q: () => process.exit(0),
    c: () => guard('continue', () => controller.continue()),
    f5: () => guard('continue', () => controller.continue()),
    n: () => guard('step over', () => controller.stepOver()),
    f10: () => guard('step over', () => controller.stepOver()),
    s: () => guard('step into', () => controller.stepInto()),
    f11: () => guard('step into', () => controller.stepInto()),
    o: () => guard('step out', () => controller.stepOut()),
    f12: () => guard('step out', () => controller.stepOut()),
    i: () => guard('step insn', () => controller.stepInstruction()),
    r: () => guard('rewind', () => controller.rewind(1)),
    b: () => {
      const state = controller.getCurrentState();
      guard('breakpoint', () => controller.setBreakpoint(state.pc));
    },
    tab: () => focusPrompt(),
    // Typing ":b Work.tick" straight at the screen used to be swallowed a
    // letter at a time by the command keys -- ":" is not bound, but "b" sets a
    // breakpoint and "o" steps out.  Opening the prompt on ":" is what every
    // other modal tool does and removes the trap entirely.
    ':': () => focusPrompt(':'),
    enter: () => focusPrompt(),
    '?': () => say(PROMPT_HELP, 'grey'),
  };
  for (const [key, handler] of Object.entries(keys)) {
    ui.screen.key([key], handler);
  }

  // ---------- prompt ----------
  const runPrompt = async (text) => {
    const line = String(text || '').trim();
    if (!line) return;
    say(`> ${line}`, 'cyan');
    try {
      if (line === ':help') return say(PROMPT_HELP, 'grey');
      if (line === ':bp') {
        const pending = controller.getPendingBreakpoints();
        const conditions = controller.getBreakpointConditions();
        return say('breakpoints: ' +
          (controller.getBreakpoints().join(', ') || 'none') +
          (pending.length ? `\npending: ${pending.join(', ')}` : '') +
          (conditions.length ? '\n' + conditions.map((entry) =>
            `  ${entry.where} if ${entry.condition}`).join('\n') : ''), 'grey');
      }
      let match = /^:b\s+(.+)$/.exec(line);
      if (match) {
        const target = controller.setBreakpointAt(match[1].trim());
        if (target.status === 'breakpoint_pending') {
          return say(`pending: ${target.where} — ${target.reason};` +
            ' it will arm when the class loads' +
            (target.condition ? ` (if ${target.condition})` : ''), 'grey');
        }
        if (target.targets) {
          return say(target.targets.map((entry) =>
            `breakpoint at offset ${entry.pc} in ${entry.className}.` +
            `${entry.signature || entry.methodName}`).join('\n'), 'grey');
        }
        const where = target.className
          ? ` in ${target.className}.${target.methodName}${target.descriptor}` +
            (target.line ? ` (line ${target.line})` : '')
          : ' (any method)';
        return say(`breakpoint at offset ${target.pc}${where}`, 'grey');
      }
      match = /^:rm\s+(\d+)$/.exec(line);
      if (match) {
        controller.removeBreakpoint(Number(match[1]));
        return say(`breakpoint removed at pc=${match[1]}`, 'grey');
      }
      if (line === ':cp') {
        const entries = controller.getClasspath();
        return say(entries.length
          ? entries.map((entry, index) => `  [${index}] ${entry}`).join('\n')
          : '  (empty classpath)', 'grey');
      }
      match = /^:cp\+\s+(.+)$/.exec(line);
      if (match) {
        const entries = controller.addClasspath(match[1].trim());
        return say(`classpath: ${entries.join(path.delimiter)}\n` +
          '(already-loaded classes stay cached)', 'grey');
      }
      match = /^:cp-\s+(.+)$/.exec(line);
      if (match) {
        const entries = controller.removeClasspath(match[1].trim());
        return say(`classpath: ${entries.join(path.delimiter) || '(empty)'}`, 'grey');
      }
      match = /^:cp=\s*(.*)$/.exec(line);
      if (match) {
        const entries = controller.setClasspath(match[1].split(path.delimiter));
        return say(`classpath: ${entries.join(path.delimiter) || '(empty)'}\n` +
          '(already-loaded classes stay cached)', 'grey');
      }
      match = /^:t\s+(\d+)$/.exec(line);
      if (match) {
        controller.selectThread(Number(match[1]));
        return say(`selected thread ${match[1]}`, 'grey');
      }
      // Anything still starting with ":" is a mistyped command, not Java.
      // Passing it to the evaluator produced a compiler error that named the
      // colon rather than saying the command does not exist.
      if (line.startsWith(':')) {
        return say(`unknown command "${line.split(/\s/)[0]}" — :help lists them` +
          ' (an expression needs no colon: press Enter or Tab instead)', 'red');
      }
      const result = await controller.evaluate(line);
      const shown = result.kind === 'statements'
        ? 'ok' : `${result.display}${result.type ? ` (${result.type})` : ''}`;
      say(shown, 'green');
    } catch (error) {
      say(error.message, 'red');
    } finally {
      render();
    }
  };

  ui.prompt.on('submit', async (value) => {
    ui.prompt.clearValue();
    await runPrompt(value);
    // Hand the keyboard back to the single-key commands, the way ":" behaves
    // in any modal editor.  Staying in the prompt would mean "c" typed after a
    // command silently did nothing instead of continuing execution.
    ui.screen.focusPop();
    setGutter(false);
  });
  // Typing a fully-qualified Java method by hand is miserable, so Tab inside
  // the prompt completes class and method names against the loaded classes.
  const completePrompt = () => {
    const value = ui.prompt.getValue() || '';
    const prefixMatch = /^(:b\s+|:rm\s+)?(.*)$/.exec(value);
    const lead = prefixMatch[1] || '';
    const partial = prefixMatch[2] || '';
    const { completion, matches } = controller.completeLocation(partial);
    if (!matches.length) {
      say(`no completion for "${partial}"`, 'grey');
    } else if (matches.length === 1) {
      ui.prompt.setValue(lead + matches[0]);
    } else {
      ui.prompt.setValue(lead + completion);
      say(matches.slice(0, 24).join('  '), 'grey');
      if (matches.length > 24) say(`… ${matches.length - 24} more`, 'grey');
    }
    ui.screen.render();
  };
  // blessed's textbox treats Tab as ordinary printable input and inserts a
  // literal tab, so the key has to be intercepted ahead of its own listener
  // rather than bound with .key().
  const baseListener = ui.prompt._listener.bind(ui.prompt);
  ui.prompt._listener = (ch, key) => {
    if (key && key.name === 'tab') {
      completePrompt();
      return undefined;
    }
    return baseListener(ch, key);
  };
  const leavePrompt = () => {
    ui.prompt.clearValue();
    ui.screen.focusPop();
    setGutter(false);
  };
  ui.prompt.key(['escape'], leavePrompt);
  // blessed's textbox cancels input on Escape without telling the screen, which
  // left the gutter claiming focus the prompt no longer had.
  ui.prompt.on('cancel', leavePrompt);

  say(`JVM debugger — ${KEY_HELP}`, 'grey');
  say('Prompt: press : (or Enter/Tab), then a Java expression or :help', 'grey');
  setGutter(false);

  try {
    await controller.start(options.className, { args: options.args });
    say(`started ${options.className}`, 'green');
  } catch (error) {
    say(`start failed: ${error.message}`, 'red');
  }
  render();
  ui.screen.render();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
