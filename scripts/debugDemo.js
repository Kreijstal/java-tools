#!/usr/bin/env node
'use strict';

const path = require('path');
const DebugController = require('../src/debug/debugController');

function printUsage() {
  console.log(`Usage: node scripts/debugDemo.js [class-name-or-file]

Examples:
  node scripts/debugDemo.js
  node scripts/debugDemo.js Hello
  node scripts/debugDemo.js sources/Hello.class

The default target is sources/VerySimple.class. A file path contributes its
directory to the JVM classpath; DebugController.start receives the class name.
`);
}

function debugTarget(argument) {
  const input = argument || path.join('sources', 'VerySimple.class');
  const extension = path.extname(input);
  const classpath = path.dirname(input) === '.' ? ['sources'] : [path.dirname(input)];
  const className = path.basename(input, extension === '.class' ? extension : undefined);
  return { classpath, className };
}

async function demonstrateDebugAPI(argument) {
  const target = debugTarget(argument);
  const options = {
    classpath: target.classpath,
    rewindHistorySize: 5,
  };
  const controller = new DebugController(options);

  console.log(`Starting ${target.className} with classpath ${target.classpath.join(path.delimiter)}`);
  const started = await controller.start(target.className);
  console.log(`status=${started.status} pc=${started.state.pc}`);
  console.log('threads=', controller.getThreads());

  controller.setBreakpoint(10);
  console.log('breakpoints=', controller.getBreakpoints());

  for (let index = 0; index < 3 && controller.isPaused(); index += 1) {
    const result = await controller.stepInstruction();
    console.log(`step=${index + 1} status=${result.status} pc=${result.state.pc}`);
  }

  if (controller.isPaused()) {
    console.log('stack=', controller.inspectStack());
    console.log('locals=', controller.inspectLocals());
    console.log('backtrace=', controller.getBacktrace());
  }

  const snapshot = controller.serialize();
  const restored = new DebugController(options);
  await restored.deserialize(snapshot);
  console.log(`restored=${restored.executionState} pc=${restored.getCurrentState().pc}`);

  if (controller.isPaused() && controller.history.length > 0) {
    const rewind = await controller.rewind();
    console.log(`rewind=${rewind.status} pc=${rewind.state.pc}`);
  }
}

if (require.main === module) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    printUsage();
  } else {
    demonstrateDebugAPI(arguments_[0]).catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = {
  debugTarget,
  demonstrateDebugAPI,
};
