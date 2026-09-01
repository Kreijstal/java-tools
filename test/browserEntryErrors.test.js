'use strict';

const test = require('tape');
const {
  BrowserJVMDebug,
  thrownValueMessage,
} = require('../src/platform/browser-entry');

test('browser run errors preserve Java exception type and message', async (t) => {
  const javaMessage = new String('late render failure');
  javaMessage.type = 'java/lang/String';
  const javaException = {
    type: 'java/lang/IllegalStateException',
    message: javaMessage,
  };
  const debug = Object.create(BrowserJVMDebug.prototype);
  debug.isReady = true;
  debug.debugController = {
    executionState: 'stopped',
    reset() {},
    jvm: {
      async run() {
        throw javaException;
      },
    },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await debug.run('Example');
    t.fail('run should reject');
  } catch (error) {
    t.equal(
      error.message,
      'Run failed: java/lang/IllegalStateException: late render failure',
      'the wrapper retains the Java type and text',
    );
    t.equal(error.cause, javaException, 'the original Java object remains the cause');
    t.equal(
      error.jvmExceptionType,
      'java/lang/IllegalStateException',
      'the Java type is machine-readable',
    );
  } finally {
    console.error = originalError;
  }
  t.end();
});

test('thrown value formatting remains useful for non-Error objects', (t) => {
  t.equal(thrownValueMessage({ type: 'java/lang/NullPointerException' }),
    'java/lang/NullPointerException', 'type-only Java exceptions are named');
  t.equal(thrownValueMessage({ reason: 'host failure' }),
    '{"reason":"host failure"}', 'plain host objects are serialized');
  t.equal(thrownValueMessage(undefined), 'undefined', 'undefined is explicit');
  t.end();
});

test('browser run errors retain host stacks and deepest guest locations', async (t) => {
  const cause = new TypeError("can't convert BigInt to number");
  cause.jvmGuestLocation = {
    className: 'ArbitraryMixer',
    methodName: 'mix',
    descriptor: '([III)V',
    pc: 27,
  };
  const debug = Object.create(BrowserJVMDebug.prototype);
  debug.isReady = true;
  debug.debugController = {
    executionState: 'stopped',
    reset() {},
    jvm: { async run() { throw cause; } },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await debug.run('Example');
    t.fail('run should reject');
  } catch (error) {
    t.equal(error.causeStack, cause.stack,
      'the original host stack remains available to telemetry');
    t.deepEqual(error.jvmGuestLocation, cause.jvmGuestLocation,
      'the deepest guest bytecode location remains machine-readable');
  } finally {
    console.error = originalError;
  }
  t.end();
});

test('browser run preparation targets the reset JVM before guest entry',
  async (t) => {
  const events = [];
  const resetJvm = {
    async run(className, options) {
      events.push(['run', className, options]);
    },
  };
  const debug = Object.create(BrowserJVMDebug.prototype);
  debug.isReady = true;
  debug.debugController = {
    executionState: 'stopped',
    jvm: {stale: true},
    reset() {
      events.push(['reset']);
      this.jvm = resetJvm;
    },
  };
  const beforeRun = async ({jvm, debugController}) => {
    events.push(['prepare', jvm, debugController]);
  };

  await debug.run('Prepared.class', {
    classpath: ['/classes'],
    beforeRun,
  });

  t.equal(events[0][0], 'reset', 'the session resets first');
  t.equal(events[1][0], 'prepare', 'preparation runs before guest entry');
  t.equal(events[1][1], resetJvm,
    'preparation receives the JVM that will execute');
  t.equal(events[1][2], debug.debugController,
    'preparation receives its owning controller');
  t.deepEqual(events[2], ['run', 'Prepared', {classpath: ['/classes']}],
    'the lifecycle callback is not forwarded as a JVM run option');
  t.equal(debug.debugController.executionState, 'stopped',
    'successful execution restores the stopped state');
  t.end();
});
