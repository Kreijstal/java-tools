# JVM debugger API

This document describes the current Node.js and browser debugger APIs. For the
visual interface, see [`docs/workbench.md`](docs/workbench.md).

## DebugController in Node.js

`DebugController` owns a JVM, starts it paused, and exposes execution control,
breakpoints, thread selection, inspection, rewind history, and debug-state
serialization.

```javascript
const DebugController = require("./src/debug/debugController");

async function main() {
    const controller = new DebugController({
        classpath: ["sources"],
        rewindHistorySize: 50
    });

    const started = await controller.start("VerySimple");
    console.log(started.status); // started
    console.log(controller.getCurrentState().executionState); // paused

    await controller.stepInstruction();
    console.log(controller.getCurrentState().pc);

    controller.setBreakpoint(5);
    const result = await controller.continue();
    console.log(result.status); // paused or stopped
}

main().catch(console.error);
```

`start` expects a class name resolvable through the configured classpath, not a
host filesystem path such as `sources/VerySimple.class`.

### Construction

```javascript
const controller = new DebugController({
    classpath: ["classes", "lib"],
    rewindHistorySize: 50
});
```

The controller passes JVM options through its constructor. A positive
`rewindHistorySize` saves lightweight debugger snapshots before steps.

### Execution control

These methods are asynchronous unless noted:

| Method | Result |
| --- | --- |
| `await start(className, options?)` | Resets execution at the class entry point and pauses |
| `await continue()` | Runs until completion, a breakpoint, or another pause |
| `pause()` | Requests a pause; valid while running |
| `await stepInstruction()` | Executes one JVM tick |
| `await stepInto()` | Executes one JVM tick |
| `await stepOver()` | Executes one JVM tick |
| `await stepOut()` | Executes one JVM tick |
| `await finish()` | Executes one JVM tick |
| `await threadStep()` | Advances until the selected thread becomes current again |
| `reset()` | Replaces the owned JVM and clears the session |

Important current limitation: `stepInto`, `stepOver`, `stepOut`, `finish`, and
`stepInstruction` currently share the same single-tick implementation. Their
names reserve the intended debugger semantics, but callers must not yet assume
method-level step-over, step-out, or finish behavior.

The controller state is one of `stopped`, `running`, or `paused`.

### Breakpoints

```javascript
controller.setBreakpoint(12);
controller.removeBreakpoint(12);
controller.clearBreakpoints();
console.log(controller.getBreakpoints());
```

Breakpoints are numeric bytecode program counters. They are currently stored as
PC values rather than source-line or fully qualified method breakpoints.

### Threads

```javascript
const threads = controller.getThreads();
// [{ id, status }, ...]

if (threads.length > 0) {
    controller.selectThread(threads[0].id);
}
```

`threadStep()` and inspection methods use the selected/current thread. The
browser workbench disables its selector and displays “No active threads” before
a session creates any threads.

### Current state and inspection

```javascript
const state = controller.getCurrentState();

console.log(state.executionState);
console.log(state.currentThreadId);
console.log(state.pc);
console.log(state.method);          // { name, descriptor }
console.log(state.stack);
console.log(state.locals);
console.log(state.callStackDepth);
console.log(state.breakpoints);
```

Additional inspection methods:

| Method | Description |
| --- | --- |
| `getBacktrace(threadId?)` | Frames for a thread |
| `inspectStack(threadId?)` | Described operand-stack values |
| `inspectLocals(threadId?)` | Described local variables |
| `inspectLocalVariable(index, threadId?)` | One local variable |
| `inspectStackValue(index, threadId?)` | One operand; negative indexes count from the top |
| `inspectObject(reference)` | Object fields and values |
| `getAvailableVariableNames(threadId?)` | Names supplied by class debug metadata |
| `getDisassemblyView()` | Disassembly, PC mapping, and current instruction |
| `isPaused()` | Whether the controller is paused |
| `isCompleted()` | Whether the controller is stopped |

Variable names and source mappings depend on optional class-file debug
attributes. Slot and PC inspection remains available without them.

## Debug snapshots and portable JVM save states

There are two related state mechanisms.

### Controller serialization

`DebugController.serialize()` captures the controller execution state and the
JVM’s debugger-oriented serialization. `deserialize` is asynchronous:

```javascript
const snapshot = controller.serialize();

const restored = new DebugController({
    classpath: ["sources"],
    rewindHistorySize: 50
});
await restored.deserialize(snapshot);

if (restored.isPaused()) {
    await restored.continue();
}
```

This is the mechanism used by rewind history. Treat it as an implementation-
compatible debugger snapshot.

### Portable JVM save state

For application checkpoints across fresh JVM instances, prefer
`JVM.saveState()` and `await JVM.loadState(state)`. These include loaded-class
statics, heap objects, threads, frames, monitors, clocks, random state, and
supported open-file state. Generated JIT code is rebuilt after restoration.

Host sockets, audio devices, and canvas objects are not serialized. The
`externalResources` section reports resources the embedding must reconnect.

See the portable save-state section in [`README.md`](README.md#portable-save-states)
for the runtime example and constraints.

## BrowserJVMDebug

The browser bundle exports:

```javascript
const { BrowserJVMDebug } = window.JVMDebug;
const debug = new BrowserJVMDebug();
await debug.initialize();
```

Initialization options:

- `workspaceFileSystem`: attach an existing workspace;
- `workspace: true`: create the default in-memory ZenFS workspace;
- `dataPackage`: load a decoded data-package object;
- `dataUrl`: fetch a JSON data-package URL.

`dataUrl` expects JSON. The workbench itself no longer ships an archive of
sample classes: it fetches `data/manifest.json` and lazily compiles the listed
`.java` sources in the browser on first use.

### Upload and start

```javascript
const loaded = await debug.loadFile(classFile);
await debug.start(loaded.virtualPath);

await debug.stepInstruction();
console.log(debug.getCurrentState());
```

`loadFile` accepts a browser `File`. JAR uploads are extracted by the file
provider; `getJarInfo(fileName)` reports their classes, resources, and manifest
entry point.

### Running without debugging

```javascript
await debug.run("example/Main");
```

`run` executes to completion without the initial debugger pause. It rejects use
before `initialize()`.

### Browser execution and inspection API

`BrowserJVMDebug` forwards the controller methods:

- `continue`, `pause`, `stepInto`, `stepOver`, `stepOut`,
  `stepInstruction`, and `rewind`;
- `setBreakpoint`, `removeBreakpoint`, `clearBreakpoints`, and
  `getBreakpoints`;
- `getCurrentState`, `getDisassemblyView`, `getBacktrace`, `inspectStack`,
  `inspectLocals`, and `getAvailableVariableNames`;
- `getThreads` and `selectThread`;
- `serialize`, `deserialize`, `saveState`, `loadState`, and `reset`.

Execution and restoration methods that return promises must be awaited.

## Browser compiler, assembler, disassembler, and workspace

The same browser entry point exposes the workbench’s bytecode tools:

```javascript
const tools = window.JVMDebug.javaTools;

const compiled = tools.compileJava(javaSource, {
    sourceFileName: "Main.java",
    sourceLevel: 8
});

const classBytes = tools.assembleJasmin(jasminSource);
const javaSource = tools.decompileClass(classBytes, { allowFallback: true });
```

Class disassembly is available from the debug instance:

```javascript
const jasmin = debug.getClassDisassembly(classBytes);
```

For multi-file compilation:

```javascript
await debug.ensureWorkspace();
debug.writeWorkspaceFile("/src/example/Main.java", source);

const result = debug.compileWorkspace(
    ["/src/example/Main.java"],
    {
        sourceRoot: "/src",
        outputDir: "/classes",
        sourceLevel: 8
    }
);
```

Workspace methods include `ensureWorkspace`, `writeWorkspaceFile`,
`readWorkspaceFile`, `compileWorkspace`, and `getFileProvider`.

See [compiler.md](docs/compiler.md) and [workbench.md](docs/workbench.md) for the
complete workflows.

## Visual debugger

Build and serve the current browser workbench:

```bash
npm run build
npm run serve
```

Open <http://localhost:3000/>, load a class or JAR, and choose **Debug**.
The view combines bytecode, the current instruction, xterm.js, thread selection,
stack, locals, call frames, breakpoints, and rewind controls.

Do not open `examples/debug-web-interface.html` directly from `file://`; use the
built site so the browser bundle, sample archive, worker assets, and styles are
available.

## Tests and executable example

The command-line demonstration is:

```bash
node scripts/debugDemo.js
```

Focused tests live in:

```bash
node node_modules/tape/bin/tape \
  test/debug.test.js \
  test/debug-enhanced.test.js \
  test/thread-debugger.test.js \
  test/rewind-debugger.test.js
npx playwright test tests/playwright/workbench-interface.spec.js \
  --project=chromium
```

Use the repository test runner if a focused filename changes:

```bash
npm test -- debug
```

## Current limitations

- semantic step-over, step-out, and finish are not yet distinct from a single
  JVM tick;
- breakpoints are numeric bytecode PCs, not source breakpoints;
- local names and source lines require class debug metadata;
- native host operations cannot be stepped through internally;
- portable save states cannot contain live host sockets, audio devices, or
  canvas objects;
- entering debugger/tracing mode disables optimized execution paths that cannot
  preserve exact frame and PC visibility.
