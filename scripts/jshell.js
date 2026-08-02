#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  JShellSession,
  formatGuestError,
} = require('../src/jshell/JShellSession');

const HELP = `Usage: node scripts/jshell.js [options]

Interactive Java shell powered by the java-tools compiler and JVM.

Options:
  --class-path <paths>  Additional classpath roots (${path.delimiter}-separated)
  --source-level <n>    Java source level (default: 8)
  --no-jit              Disable the jvm.js JIT
  --verbose             Enable JVM diagnostics
  --keep-workspace      Keep generated snippet sources/classes on exit
  -h, --help            Show this help

Commands:
  /list       List accepted snippets
  /vars       List variable declarations
  /methods    List method declarations
  /types      List type declarations
  /imports    List imports
  /reset      Clear the session
  /save FILE  Save accepted snippets
  /exit       Exit the shell
  /help       Show shell help`;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--class-path' || arg === '--classpath') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      options.classpath = argv[++i];
    } else if (arg === '--source-level') {
      if (i + 1 >= argv.length) throw new Error('--source-level requires a value');
      options.sourceLevel = Number.parseInt(argv[++i], 10);
    } else if (arg === '--no-jit') {
      options.jit = false;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--keep-workspace') {
      options.keepWorkspace = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function snippetComplete(source) {
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      i++;
    } else if (char === '"' || char === '\'') {
      quote = char;
    } else if (char === '{') braces++;
    else if (char === '}') braces--;
    else if (char === '(') parentheses++;
    else if (char === ')') parentheses--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
  }
  return !quote && !blockComment &&
    braces <= 0 && parentheses <= 0 && brackets <= 0;
}

function acceptedMessage(result) {
  if (result.kind === 'import') return `|  imported ${result.name}`;
  if (result.kind === 'variable') {
    return result.name ? `|  created variable ${result.name}` : '|  created variable';
  }
  if (result.kind === 'method') {
    return result.name ? `|  created method ${result.name}` : '|  created method';
  }
  if (result.kind === 'type') {
    return result.name ? `|  created type ${result.name}` : '|  created type';
  }
  return null;
}

function printList(session, kind = null) {
  const snippets = session.list(kind);
  if (snippets.length === 0) {
    process.stdout.write('|  (none)\n');
    return;
  }
  for (const snippet of snippets) {
    const index = session.snippets.indexOf(snippet) + 1;
    process.stdout.write(`${index} : ${snippet.source}\n`);
  }
}

async function executeCommand(text, state) {
  const [command, ...args] = text.trim().split(/\s+/);
  if (command === '/exit') return false;
  if (command === '/help') {
    process.stdout.write(`${HELP}\n`);
  } else if (command === '/list') {
    printList(state.session);
  } else if (command === '/vars') {
    printList(state.session, 'variable');
  } else if (command === '/methods') {
    printList(state.session, 'method');
  } else if (command === '/types') {
    printList(state.session, 'type');
  } else if (command === '/imports') {
    printList(state.session, 'import');
  } else if (command === '/reset') {
    await state.session.reset();
    process.stdout.write('|  reset\n');
  } else if (command === '/save') {
    if (args.length !== 1) {
      process.stderr.write('|  Error: /save requires one file path\n');
    } else {
      const outputPath = path.resolve(args[0]);
      const textToSave = state.session.snippets.map((snippet) => snippet.source).join('\n\n');
      fs.writeFileSync(outputPath, `${textToSave}\n`);
      process.stdout.write(`|  saved ${outputPath}\n`);
    }
  } else {
    process.stderr.write(`|  Error: unknown command ${command}\n`);
    state.hadError = true;
  }
  return true;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const state = {
    session: new JShellSession(options),
    hadError: false,
  };
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const input = readline.createInterface({
    input: process.stdin,
    output: interactive ? process.stdout : undefined,
    terminal: interactive,
  });
  if (interactive) {
    process.stdout.write('java-tools JShell\nType /help for help.\n\n');
    input.setPrompt('jshell> ');
    input.prompt();
  }

  let pending = '';
  try {
    for await (const line of input) {
      if (!pending && line.trim().startsWith('/')) {
        const keepRunning = await executeCommand(line, state);
        if (!keepRunning) break;
      } else {
        pending = pending ? `${pending}\n${line}` : line;
        if (!snippetComplete(pending)) {
          if (interactive) {
            input.setPrompt('   ...> ');
            input.prompt();
          }
          continue;
        }
        const source = pending;
        pending = '';
        try {
          const result = await state.session.evaluate(source);
          const message = acceptedMessage(result);
          if (message) process.stdout.write(`${message}\n`);
        } catch (error) {
          state.hadError = true;
          process.stderr.write(`|  Error: ${formatGuestError(error)}\n`);
        }
      }
      if (interactive) {
        input.setPrompt('jshell> ');
        input.prompt();
      }
    }
    if (pending.trim()) {
      state.hadError = true;
      process.stderr.write('|  Error: incomplete snippet at end of input\n');
    }
  } finally {
    input.close();
    if (options.keepWorkspace) {
      process.stderr.write(`|  workspace: ${state.session.workspace}\n`);
    }
    state.session.close();
  }
  if (state.hadError) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${formatGuestError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  acceptedMessage,
  parseArgs,
  snippetComplete,
};
