# JVM Tools - Advanced Java Bytecode Analysis & Execution

[![CI](https://github.com/Kreijstal/java-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/Kreijstal/java-tools/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/node.js-18.x%20%7C%2020.x-green.svg)](https://nodejs.org/)
[![Java](https://img.shields.io/badge/java-11%20%7C%2017-orange.svg)](https://adoptopenjdk.net/)

A comprehensive toolkit for Java bytecode analysis, manipulation, and execution. This project provides advanced tools for working with Java `.class` files, including a custom JVM implementation, web-based debugging interface, and extensive bytecode analysis capabilities.

## 🌟 Key Features

### 🔍 Advanced Bytecode Analysis
- **Class File Parsing**: Complete Java class file format support using `jvm_parser`
- **AST Generation**: Convert bytecode to structured Abstract Syntax Trees
- **Method Analysis**: Deep inspection of methods, fields, and class hierarchies
- **Bytecode Manipulation**: Modify and reassemble Java bytecode

### 🚀 Custom JVM Implementation
- **Full Instruction Set**: Comprehensive Java bytecode instruction support
- **Runtime Execution**: Execute Java classes directly in Node.js
- **Multi-threading**: Java threading model implementation
- **Memory Management**: Stack, heap, and garbage collection

### 🐛 Web-Based Debugging
- **Visual Debugger**: Step-by-step execution with web interface
- **Real-Time Inspection**: Examine JVM state, stack, and local variables
- **Breakpoint Management**: Set and manage execution breakpoints
- **State Serialization**: Save and restore JVM execution state

### 🎨 Browser Integration
- **AWT Support**: Run Java GUI applications in browsers
- **Web Assembly**: Java bytecode execution in web environments
- **Cross-Platform**: Same code runs in Node.js and browsers

### 🛠️ Development Tools
- **Native Assembly/Disassembly**: JavaScript Jasmin parser, class-file writer, and class disassembler
- **Class Manipulation**: Load, modify, and generate class files
- **Native Methods**: JNI (Java Native Interface) support
- **Build System**: Complete webpack-based build pipeline

## 📋 Use Cases

### Development & Analysis
- **Java Learning**: Study JVM internals and bytecode execution
- **Reverse Engineering**: Analyze and understand Java applications
- **Code Analysis**: Build static analysis tools for Java bytecode
- **Security Research**: Examine compiled Java applications

### Web Deployment
- **Legacy Migration**: Run Java applications in modern browsers
- **Cross-Platform Apps**: Deploy Java applications without JVM installation
- **Educational Tools**: Teach Java programming with browser execution

### Tool Development
- **Custom JVMs**: Build specialized Java runtime environments
- **Bytecode Tools**: Create advanced Java development utilities
- **Testing Frameworks**: Develop Java testing and debugging tools

## 🚀 Quick Start

### Installation

```bash
npm install
```

### Basic Usage

#### Parse and Analyze a Java Class

```bash
# Compile a Java source file
javac sources/Hello.java

# Parse and analyze the class file
node scripts/runLoadAndTraverse.js Hello sources
```

#### Run the native JavaScript CFR-style decompiler

```bash
npm run cfr -- sources/VerySimple.class
npm run cfr -- --outputdir /tmp/decompiled sources/VerySimple.class
```

`npm run cfr` uses `src/decompiler/cfr.js`, so it does not require `CFR.jar` or a Java process. The CFR fixture tests under `test/fixtures/cfr` assemble bytecode with the repo-native Jasmin assembler and compare the JavaScript decompiler against ported CFR expected-output bodies.

#### Provably goto-free structurer

`src/decompiler/structurer.js` turns any **reducible** control-flow graph into a
goto-free statement tree (loops + labeled `break`/`continue`), `src/passes/regionSplit.js`
makes irreducible graphs reducible by controlled node splitting, and
`src/decompiler/exceptionStructurer.js` adds a conservative try/catch layer that
bails with a reason rather than ever emitting wrong Java. Together they clear the
control-flow shapes on which CFR and Vineflower give up. See
[docs/decompiler.md](docs/decompiler.md) for the design, the algorithms, and the
rationale for owning the structurer instead of chasing third-party decompiler
heuristics.

#### Execute Java Bytecode

```bash
# Run a Java class with the custom JVM
node scripts/runJvm.js sources/Hello.class
```

```bash
# Run an executable jar using META-INF/MANIFEST.MF Main-Class
node scripts/runJar.js app.jar

# Run an applet-style jar by naming the entry class
node scripts/runJar.js --class VecDemo vector.jar
```

The JVM JIT selects methods from bytecode shape and observed execution; it does
not use application class names or method-signature allowlists. Exception and
monitor control flow (`athrow`, `monitorenter`, and `monitorexit`) is compiled by
default only for leaf normal-flow regions, where generated execution cannot move
a Java call across an interpreter scheduler boundary. Calls that are reachable
only from an exception handler do not disqualify the leaf body. Set
`JVM_JIT_EXPERIMENTAL_CONTROL_FLOW=1` to enable the broader capability globally
for runtime experiments. Calls to unsupported methods permanently deopt their
compiled caller instead of using application-specific resume rules.

For generated JavaScript, bounded straight-line integer regions are compiled
across static call chains. Verified static leaves are emitted directly into the
caller, while monomorphic virtual and interface sites cache the observed target
and execute its collapsed integer region without child frames. Debugging,
class initialization, unsupported bytecodes, exceptions, recursion, and
oversized regions retain the normal dispatch path. Direct source emission is
disabled when per-method profiling is enabled so call-site counters remain
available.

Verified handler-free integer loops also have a scalar tier. It derives CFG and
operand-stack depths from bytecode, keeps used locals and stack expressions in
JavaScript scalars, and emits bounded backedge safe points that reconstruct the
ordinary `Frame` before yielding. Static callees are accepted only when their
entire integer body is structurally inlineable; no class or method names take
part in selection. Set `jit: { scalarLoops: false }` to retain the existing
generated implementation for differential tests.

An experimental extension accepts structurally verified array/field loops,
rethrow-only reporter handlers, and synchronous static call islands. It keeps
internal CFG joins in fixed scalar slots and materializes the `Frame` only at
calls, safe points, returns, and throwing bytecodes. This broader tier is off by
default because its Dekobloko result remains below the renderer acceptance
target; enable it with `jit: { scalarGuestBodies: true }` or
`JVM_ENABLE_SCALAR_GUEST_BODIES=1`.

A TeaVM-inspired SSA experiment adds raw-array-view companions, basic-block
value numbering for repeated field/length reads, and verified fall-through edge
threading. It preserves canonical heap objects for snapshots and precise frame
materialization for exceptions and safe points. Enable it with
`jit: { scalarSsaOptimizations: true }` or `JVM_ENABLE_SCALAR_SSA=1`; it remains
off by default because the combined experimental renderer remains below its
acceptance target. Basic-block SSA was neutral, and an alias-safe cross-block
field cache was removed after its final counter-free A/B regressed the median
from 13.3291 to 13.0458 changed images/s. The browser probe can isolate the
retained basic pass with `PROBE_SCALAR_SSA=0/1`.

The experimental structured SSA tier removes the remaining basic-block
dispatcher for verified reducible JVM loops. It assigns every produced operand
a unique JavaScript value, feeds live operands into fixed successor-block join
slots, and renders the CFG through lexical `while`, `if`, labeled `break`, and
`continue` statements. Integer/reference locals, arrays, fields, integer
arithmetic, synchronous static calls, and rethrow-only handlers are supported;
throwing operations and bounded loop safe points reconstruct the exact JVM PC,
locals, and operand order. Selection uses descriptors and verified bytecode/CFG
properties, never class or method names. Enable it with
`jit: { structuredSsa: true }`, `JVM_ENABLE_STRUCTURED_SSA=1`, or the Firefox
probe switch `PROBE_STRUCTURED_SSA=1`. It remains off by default pending broader
coverage and the 20 changed-images/s acceptance target.

To compose the three renderer experiments without independent switches, use
`jit: { rendererPipeline: true }`, `JVM_ENABLE_RENDERER_PIPELINE=1`, or
`PROBE_RENDERER_PIPELINE=1`. This enables broad scalar guest bodies, fused
wrapper/raster regions, and structured SSA together; individual probe switches
can still override a component for differential runs. The measured composed
median was 13.0388 changed images/s with structured SSA versus 12.1244 without
it (+7.54%), with matching accepted hashes and no browser errors; the combined
pipeline remains opt-in because it is still below the 20 images/s target.

On the measured Dekobloko Firefox workload, scalarizing the large model/face
guest body and combining it with the verified renderer region raised throughput
from 8.82 to 13.19 changed images/s—about a 49% improvement—with matching surface
hashes and no runtime errors. The result identifies cross-branch operand-stack
traffic in the large guest CFG as a material cost, while also showing that the
remaining geometry/raster arithmetic still prevents the 20 images/s target.
The full measurement and the `array[index++]` JVM-ordering regression discovered
during the work are documented in
[`docs/dekobloko-firefox-performance.md`](docs/dekobloko-firefox-performance.md#2026-07-20-breakthrough-compile-the-guest-body-not-just-its-leaves).

The Wasm numeric tier links fully translatable loop-free static helpers into hot
loops on demand, including helpers with reference parameters. It also recognizes
bounded, forward-only, always-rethrow diagnostic handlers as non-recovering, so
their protected compute loops remain eligible. A catch that returns, acquires a
monitor, loops backwards, or writes recovery state remains interpreted.

The intermethod benchmark compares the same primitive hot loop on HotSpot, the
generated-JavaScript tier, and the Wasm tier, using zero-call, eight-static-call,
virtual, and interface shapes:

```bash
npm run benchmark:jvm:intermethod
# Optional: INTERMETHOD_ITERATIONS=100000 INTERMETHOD_ROUNDS=7
```

It validates checksums across all tiers and reports medians, resolved JavaScript
call-site kinds, and Wasm compilation/exits. `INTERMETHOD_PROFILE_JIT=1` also
enables per-call JIT counters, at the cost of perturbing timing.

The primary renderer-optimizer benchmark is now a deterministic Java fixture
distilled from Dekobloko's hot loops rather than the full game startup:

```bash
npm run benchmark:jvm:dekobloko-hot-loops
# Optional: DEKOBLOKO_TOY_INVOCATIONS=100 DEKOBLOKO_TOY_PASSES=40 \
#           DEKOBLOKO_TOY_ROUNDS=5 DEKOBLOKO_TOY_WARMUPS=3
```

It covers nested vertex transforms and face selection using instance fields,
`int[]`/`short[]` loads, checked stores, fixed-point multiply/shift/divide,
visibility branches, and a small static helper. HotSpot, ordinary generated JS,
broad scalar JS, and structured SSA must produce identical checksums before any
timing is reported. Use the full JAR only as the final integration/correctness
check after a toy-loop optimization demonstrates a repeatable improvement.

That benchmark exposed an inner-face generic call transition: the small integer
helper contained one forward branch, so the straight-line leaf inliner rejected
it and materialized/dispatched a JVM call for every visible face. The structural
inliner now lowers bounded forward-branching integer leaves with SSA join values,
without class or method-name matching. In the clean five-round run, structured
face work fell from 315.1315 to a three-process median of 11.8466 ns/element
(**26.60× faster**), combined work fell from 196.1672 to 10.9281 ns/element
(**17.95× faster**), and all tier
checksums matched HotSpot. A subsequent three-process Firefox integration run
measured 11.21, 13.33, and 13.48 changed images/s (13.33 median), with expected
surface hashes and no page/console errors. This retains the previous ~13 FPS
class but remains below the 20 images/s target.

The follow-up renderer-traffic benchmark adds the work omitted by the first
toy: clipped static-surface spans and 22 structurally recognized overlapping
primitive copies per synthetic unit:

```bash
npm run benchmark:jvm:dekobloko-renderer-traffic
# Optional: DEKOBLOKO_TRAFFIC_INVOCATIONS=10 DEKOBLOKO_TRAFFIC_PASSES=2 \
#           DEKOBLOKO_TRAFFIC_ROUNDS=5 DEKOBLOKO_TRAFFIC_WARMUPS=3
```

The initial checksums matched HotSpot but exposed 85.27× slower overlap copies
and 83.82× slower composed traffic. The JIT now emits both verified operations
positionally into structured callers, selected by descriptor, bytecode shape,
stack verification, and field identity—not method names. A raw Node
microbenchmark also showed that `copyWithin` is expensive for these tiny generic
arrays, so the verified overlapping `int[]` path uses an explicit reverse loop.
In the subsequent checksum-matched run, structured spans improved from 628.18
to 235.03 ns/op, copies from 868.64 to 20.11 ns/op, and composed work from
852.95 to 24.25 ns/op. One synthetic traffic unit fell from 19.618 to 0.558
microseconds and measured 2.40× HotSpot.
The rebuilt production bundle did not turn that isolated gain into more game
FPS: three clean Firefox runs measured 13.95, 12.90, and 13.04 changed images/s
(13.04 median), with expected initial hashes and no runtime errors. High call
counts identified real avoidable JVM work, but not the dominant remaining
wall-clock cost.

For representative renderer work, use the captured entry-state replay rather
than another hand-written approximation. The Firefox probe can take a portable
heap/static/local snapshot at an actual generated method's PC 0, and
`benchmark:jvm:dekobloko-trace-replay` restores and repeatedly executes that
complete guest body. The first `vk.a(I)V` capture reproduced 3,689 scheduler
ticks per scene invocation and identical 75,600-pixel hashes across tiers.
Generated, scalar, and composed structured execution measured 54.60, 35.88,
and 23.86 ms/invocation respectively. This revealed that repeated partial-region
resumption—not the isolated copy/span arithmetic—is the representative
remaining JVM inefficiency. Capture and replay commands are documented in the
performance investigation below.

The first replay-driven change added generic generated-code support for fixed-
point `lmul`, arithmetic `lshr`, and `l2i`. It reduced complete-scene scheduler
entries from 3,689 to 9 and improved structured replay time from 23.86 to 19.63
ms (21.5%), with all surface and static hashes unchanged. Three Firefox runs
passing the expected initial-hash gate measured 14.28, 13.80, and 13.95 changed
images/s (13.95 median), a 7.0% improvement over the immediate 13.04 baseline.
This validates the captured replay as a useful predictor, while confirming that
reaching 30 FPS requires attacking more than scene-transition overhead.

Smaller real-input benchmarks can be derived from that same scene state with
`trace:dekobloko:derive-region` and run together with
`benchmark:jvm:dekobloko-regions`. Unlike the earlier handwritten toys, these
cases preserve the live locals, heap, statics, and raster surface and verify the
complete surface plus scalar/static-array state after every timing round. The
first four-case suite isolated two large geometry bodies and the gradient/flat
wrapper-to-raster chains. Composed structured execution measured 3.04x and
1.97x faster than generated JS for the geometry bodies, versus 1.45x and 1.24x
for individual wrapper chains. This makes the mixed 592-bytecode geometry body,
not a single raster call, the most useful focused benchmark for the next generic
optimizer change. Method keys configure trace capture only; optimizer selection
remains descriptor-, CFG-, opcode-, and runtime-shape-based.

The first optimization driven by those focused cases tested bounded controlled
splitting for irreducible integer CFGs. The 592-bytecode geometry body contained
one secondary loop entry; cloning 39 abstract CFG blocks made it reducible and
allowed the lexical SSA renderer to compile it, without changing guest bytecode
or using a method-name gate. Focused Node replay improved from 0.545 to 0.469 ms
and complete-scene replay from 19.627 to 17.440 ms, with all differential hashes
unchanged. Firefox contradicted V8: three active, expected-hash runs measured
13.18, 12.37, and 12.91 images/s (12.91 median), 7.5% below the previous 13.95
median. Counters proved that two methods and 44 blocks were split. The feature
is therefore disabled by default and retained only behind
`structuredIrreducibleSplitting`, with replay and Firefox A/B overrides. This
teaches that the live replay is a semantic oracle but V8 cannot predict
SpiderMonkey's response to a roughly 441 KB generated function; the next design
should use a compact local state-machine island instead of whole-SCC cloning.

For bottleneck attribution, use `PROBE_SCHEDULER_TIMINGS=1` rather than method
entry counts. It records non-overlapping scheduler-slice wall time owned by the
active guest frame. The first exact 20-image run attributed 90.7% of the window
to JVM execution: 32.4% to the complete scene owner and another 26.9% to the
next five surface, render, game-logic, Canvas, and array bodies. Every-slice
timing has measurable observer overhead and is diagnostic only; ordinary FPS
acceptance keeps it disabled.

To subdivide one expensive generated root by wall time, use
`PROBE_EXCLUSIVE_TIMINGS=1` with `PROBE_EXCLUSIVE_ROOT`. Nested clocks pause
their parents, so exclusive method totals do not overlap and sum exactly to the
root; parent-to-child edges retain the hierarchy. A clean Firefox run attributed
370 of the scene root's 561 ms (66.0%) to the geometry/face subtree: 147 ms in
its scalar geometry/control body, 164 ms in the fused gradient raster, 39 ms in
a structured helper, and 20 ms in the fused flat raster. The transform subtree
used another 153 ms, while the scene root itself used only 15 ms exclusive.
This identifies geometry plus raster work—not call dispatch—as the next target.
The configured method key is diagnostic input only and no optimizer contains a
game method-name gate.

The Dekobloko Firefox investigation, including measured wins, rejected
experiments, correctness traps, and the reproducible changed-frame probe, is
recorded in
[docs/dekobloko-firefox-performance.md](docs/dekobloko-firefox-performance.md).
Start with its
[executive synthesis](docs/dekobloko-firefox-performance.md#executive-synthesis),
then use the sections on the
[actual hot guest features](docs/dekobloko-firefox-performance.md#what-the-hot-guest-body-actually-contains),
[current tier defaults](docs/dekobloko-firefox-performance.md#current-tier-and-configuration-status),
[Java/JavaScript/Wasm intermethod results](docs/dekobloko-firefox-performance.md#latest-intermethod-benchmark-what-should-and-should-not-become-wasm),
[snapshot and debugger constraints](docs/dekobloko-firefox-performance.md#snapshots-debugging-scheduling-and-exceptions),
[measurement procedure](docs/dekobloko-firefox-performance.md#reproducing-the-firefox-measurement),
and the
[structured-loop implementation handoff](docs/dekobloko-firefox-performance.md#structured-natural-loops-completed-foundation-and-remaining-work).

#### Portable save states

`JVM.saveState()` captures a JSON-compatible execution checkpoint and
`await JVM.loadState(state)` restores it into a fresh JVM. Unlike the debugger's
lightweight `serialize()` history, a save state includes loaded-class statics,
the shared/cyclic Java heap, frame locals and operand stacks, thread and monitor
references, class initialization, interned strings, relative sleep deadlines,
and `long`/BigInt values.

```js
const checkpoint = jvm.saveState();
fs.writeFileSync('game.state.json', JSON.stringify(checkpoint));

const resumed = new JVM({ classpath });
await resumed.loadState(JSON.parse(fs.readFileSync('game.state.json', 'utf8')));
await resumed.execute();
```

Generated JS and Wasm are rebuilt after loading, keeping states portable across
JavaScript engines. Random-access files reopen from their saved path, mode, and
position. Host sockets, audio devices, and canvas objects are not serialized;
`externalResources` lists omissions so an embedding can reconnect or recreate
them. Capture at a scheduler boundary rather than during a pending native call.

#### Web-Based Debugging

```bash
# Start the development server
npm run serve
```

Then open http://localhost:3000 to access the debugging interface.

To load your own application, select **File**, choose a `.jar`, and click
**Load**. The site extracts its class files in the browser and uses
`META-INF/MANIFEST.MF`'s `Main-Class` as the default entry point. If the JAR
does not declare one, choose a class from the entry-class picker before running
or debugging it.

## 🏗️ Architecture

### Core Components

```
src/
├── jvm.js                 # Main JVM implementation and execution engine
├── frame.js              # Stack frame management and local variables
├── classLoader.js        # Dynamic class loading and resolution
├── debugController.js    # Debugging functionality and controls
├── browser-entry.js      # Browser-specific entry point and API
├── instructions/         # Complete bytecode instruction set
├── jre/                  # Java Runtime Environment implementation
├── awt.js               # Browser AWT (Abstract Window Toolkit)
└── convert_tree.js      # AST conversion and bytecode manipulation
```

### Key Features

#### JVM Runtime
- **Complete Bytecode Support**: All major JVM instructions implemented
- **Multi-threading**: Java thread model with synchronization
- **Exception Handling**: Full Java exception system
- **Memory Model**: Stack and heap management

#### Class Loading System
- **Dynamic Resolution**: Load classes at runtime
- **Verification**: Bytecode format validation
- **Linking**: Class preparation and initialization

#### Web Integration
- **Browser JVM**: Execute Java in web browsers
- **Visual Debugging**: Step-through interface
- **State Management**: Serialize and restore execution state

## 📚 Usage Examples

### 1. Basic Class Analysis

```javascript
const { loadClassByPath } = require('./src/core/classLoader');

// Load and parse a class file
const classData = await loadClassByPath('MyClass.class');
console.log('Class name:', classData.ast.classes[0].className);
console.log('Methods:', classData.ast.classes[0].items.filter(item => item.type === 'method'));
```

### 2. JVM Execution

```javascript
const { JVM } = require('./src/core/jvm');

const jvm = new JVM({
    verbose: true,
    classpath: 'sources'
});

// Execute a Java class
await jvm.run('Hello.class');
```

### 3. Web-Based Debugging

```javascript
// In browser environment
const { BrowserJVMDebug } = window.JVMDebug;

const debugger = new BrowserJVMDebug();

// Initialize with data package
await debugger.initialize({
    dataUrl: '/dist/data.zip'
});

// Start debugging session
await debugger.start('com.example.MyClass');

// Control execution
debugger.setBreakpoint(10);
debugger.stepInto();
debugger.continue();
```

### 4. Bytecode Manipulation

```javascript
const { getAST, convertJson } = require('./src/parsing/convert_tree');
const { unparseDataStructures } = require('./src/parsing/convert_tree');

// Parse class file
const classData = fs.readFileSync('MyClass.class');
const ast = getAST(classData);
const converted = convertJson(ast.ast, ast.constantPool);

// Modify the AST as needed
// ... modify converted.classes[0] ...

// Generate new bytecode
const newBytecode = unparseDataStructures(converted.classes[0], converted.constantPool);
```

See `docs/dead_code_elimination.md` for a detailed walkthrough of assembling `.j` sources, parsing the resulting `.class`, running the stack-based dead-code eliminator, and emitting updated assembly.

### Jasmin Lint & Fix CLI

Use the unified JVM CLI to surface the same dead-code diagnostics and jump-handler fixes that power the LSP workflow:

```bash
# Show diagnostics for a Jasmin file
node scripts/jvm-cli.js lint examples/sources/jasmin/MisplacedCatch.j

# Apply the recommended fix in place
node scripts/jvm-cli.js lint --fix examples/sources/jasmin/MisplacedCatch.j

# Or write the fix to a separate file
node scripts/jvm-cli.js lint --fix --out /tmp/MisplacedCatch.fixed.j examples/sources/jasmin/MisplacedCatch.j

# Need cross-reference breadcrumbs plus purity/exception summaries in the resulting Jasmin? Add
# `--xref-comments` and point the command at a classpath so it can index the surrounding workspace:
node scripts/jvm-cli.js lint --fix --classpath sources --xref-comments examples/sources/jasmin/MisplacedCatch.j

# Need the optimized Jasmin on stdout without touching the file? Pair `--fix` with `--stdout`
# (and optionally `--classpath` / `--xref-comments`):
node scripts/jvm-cli.js lint --fix --stdout examples/sources/jasmin/MisplacedCatch.j

# npm shortcut
npm run lint:jasmin -- --fix examples/sources/jasmin/MisplacedCatch.j
```

When `--fix` is supplied, the tool rewrites the target file (or the path provided via `--out`) with the optimized handler layout.

### Unified JVM CLI

The helper `scripts/jvm-cli.js` centralizes common JVM/Jasmin workflows:

```bash
# Assemble/disassemble
node scripts/jvm-cli.js assemble examples/sources/jasmin/MisplacedCatch.j
node scripts/jvm-cli.js disassemble build/classes/Hello.class --out /tmp/Hello.j

# Rename classes or methods in-place (works for .j and .class)
node scripts/jvm-cli.js rename-class examples/sources/jasmin/MisplacedCatch.j \
    --from MisplacedCatch --to MCatch -n   # dry-run; prints diff
node scripts/jvm-cli.js rename-method build/classes/Hello.class \
    --class Hello --from greet --to greetSafe --descriptor '()V'

# Dead-code optimization (alias for `lint --fix`)
node scripts/jvm-cli.js optimize examples/sources/jasmin/MisplacedCatch.j --out /tmp/MisplacedCatch.opt.j

# Canonical Jasmin formatting
node scripts/jvm-cli.js format examples/sources/jasmin/MisplacedCatch.j -n   # preview diff only
```

Use `node scripts/jvm-cli.js --help` to see the complete list of subcommands and flags. All mutating operations accept `-n/--dry-run` to preview the unified diff without touching the input file.

See `docs/tooling.md` for a deeper tour of the CLI, the workspace TUI, the MCP server’s JSON-RPC surface, and how these building blocks roll up into the planned LSP.

## 🔧 Configuration

### JVM Options

```javascript
const jvm = new JVM({
    verbose: true,           // Enable detailed logging
    maxStackDepth: 1024,     // Maximum call stack depth
    classpath: 'lib',        // Default classpath
    debugMode: true,         // Enable debugging features
    enableAWT: true         // Enable AWT graphics support
});
```

### Build System

```bash
# Install dependencies
npm install

# Build Java sources
npm run build:java

# Build web bundle
npm run build

# Run tests
npm test

# Start development server
npm run serve
```

## 🌐 Web Interface

### Visual Debugger Features
- **Disassembly View**: Syntax-highlighted bytecode with current instruction indicator
- **Execution Controls**: Step into, over, out, continue, and rewind
- **State Inspection**: Real-time display of stack, locals, and JVM state
- **Breakpoint Management**: Set breakpoints by clicking in the disassembly view

### Sample Applications
- **Built-in Examples**: Pre-compiled Java test cases
- **File Upload**: Load your own .class and .jar files
- **Class Browser**: Navigate methods and fields

### AWT Graphics
- **Canvas Rendering**: Java GUI components in HTML5 Canvas
- **Event Translation**: Browser events converted to AWT events
- **Layout Support**: Proper component layout and rendering

## 🧪 Testing

Run the comprehensive test suite:

```bash
# Run all tests
npm test

# Skip test files by substring or glob
npm test -- --skip roundtrip
JVM_TEST_SKIP=roundtrip npm test

# Continue through later test files after a failure
npm test -- --continue-on-failure

# Run specific test files/categories
npm test -- arithmetic
npm run test:cfr  # integration plus ported CFR fixture coverage

# Run browser tests
npm run test:playwright
```

## 📁 Project Structure

```
├── src/                    # Core implementation
│   ├── jvm.js             # Main JVM engine
│   ├── classLoader.js     # Class loading system
│   ├── instructions/      # Bytecode instructions
│   ├── jre/               # Java Runtime Environment
│   └── awt.js             # Browser graphics
├── sources/               # Java source files and examples
├── test/                  # Test files and test runners
├── scripts/               # Build and utility scripts
├── examples/              # Web interface examples
├── tools/                 # Optional external bytecode tools
└── dist/                  # Built distribution files
```

## 🔗 JVM Assembly and Disassembly

The repository has native JavaScript bytecode tooling:

- **Disassembly**: `node scripts/jvm-cli.js disassemble Foo.class --stdout`
- **Assembly**: `node scripts/jvm-cli.js assemble Foo.j --out Foo.class`
- **Manipulation**: Modify class ASTs and write `.class` files with `src/parsing/classAstToClassFile.js`
- **Decompilation**: `npm run cfr -- Foo.class` uses the JavaScript CFR-style decompiler

## 🤝 Contributing

We welcome contributions! Areas for improvement:

- Additional bytecode instruction implementations
- Enhanced JRE class library coverage
- Improved web interface features
- Performance optimizations
- Documentation enhancements

## 📄 License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) for details.

## 🧬 Bytecode Deobfuscation Pipeline

`scripts/jvm-cli.js` exposes a series of bytecode-rewriting passes designed to
turn obfuscated `.class` files into shapes that decompilers (CFR, Vineflower,
…) can structure cleanly.

### Available passes

| CLI subcommand | What it does |
|---|---|
| `peephole-clean` | Removes nops, safe conditional-branch goto bridges, single-use fall-through gotos, unreferenced labels. Run it twice — once before structural passes (cleans up obfuscator noise) and once after (collapses anything the structural passes leave behind). |
| `strip-rethrow-handlers --keep-handler-code` | Drops trivial catch-and-rethrow exception-table entries while retaining bare `athrow` sentinels in the instruction stream. Removing both made CFR worse; the Diobfuscator-style "table-only" strip is the right move. |
| `multi-entry-normalize` | Clones loop-header blocks for each forward edge so loops have a single semantic entry. Includes a forward-only join splitter for fallthrough-joined CFG diamonds. |
| `coalesce-loop-load` | Folds `LOAD X; goto T2; T1: LOAD X; T2: <use X>` into `goto T1`, eliminating the duplicate prefix that multi-entry normalization tends to leave. Handles local loads, `getstatic`, constants, and `aload_0` (gated on no `astore_0` in the method). |
| `dead-flag-eliminate` | Removes dead conditionals on caller-supplied always-false static boolean flags. Pass `--flags Cls.f,Other.g`. |
| `inline-shared-exit-goto` | Tail-duplicates a shared exit/merge target's body at the goto-site reached as the fallthrough of a conditional jump. Targets the exact CFG shape javac produces inline but the obfuscator collapsed into a shared `goto EXIT`. See `src/inlineSharedExitGoto.js` for the gates (≥4 forward predecessors, body ≥5 and ≤50 insns ending in goto/return, an "inner predecessor" inside the conditional's then-target body, etc.). |

### Recommended pipeline

```bash
node scripts/jvm-cli.js peephole-clean foo.class --out foo.class
node scripts/jvm-cli.js strip-rethrow-handlers foo.class --keep-handler-code --out foo.class
node scripts/jvm-cli.js multi-entry-normalize foo.class --out foo.class
node scripts/jvm-cli.js coalesce-loop-load foo.class --out foo.class
node scripts/jvm-cli.js dead-flag-eliminate foo.class --flags Cls.f,Other.g --out foo.class
node scripts/jvm-cli.js inline-shared-exit-goto foo.class --max-body-insns 50 --out foo.class
node scripts/jvm-cli.js peephole-clean foo.class --out foo.class
```

**Important: round-trip the bytecode between passes.** Each CLI invocation
parses the `.class`, applies the pass, and serializes back to bytecode. The
serialize/parse round-trip normalizes stack-map frames, label aliases, and
constant-pool ordering — and several passes assume that normalized state. The
`scripts/bulk-pipeline.js` helper demonstrates the correct in-process
round-trip flow for batch use.

### Discovered transform: `inline-shared-exit-goto`

The new pass came from a javac-roundtrip experiment. Hand-writing Java that
matches the obfuscated semantics for `td.c(Lvl;)V` (including the unusual
"var10==0 → method exit, not loop continue" branch) and letting javac compile
it produces bytecode that CFR decompiles cleanly. Diffing that against the
obfuscated bytecode revealed the difference: javac inlines the method-exit
prologue at certain conditional-fallthrough sites; the obfuscator collapsed
those inlines into a shared `goto EXIT` chain. Reproducing javac's inline
shape (tail-duplicating the exit prologue at the right predecessor) drove
`td` from 2 markers to 0 and `lk` from 3 to 0.

### Bulk pipeline runner

For batch deobfuscation:

```bash
# scripts/bulk-pipeline.js IN_DIR OUT_DIR [--skip-inline]
node scripts/bulk-pipeline.js classes-original/ output/
```

Single Node.js process; round-trips between every pass.

## 🙏 Acknowledgments

- **jvm_parser**: Java class file parsing library
- **Jasmin/Krakatau-style syntax**: Inspiration for the assembly representation
- **Java Community**: Inspiration from various JVM implementations

---

**JVM Tools** - Advanced Java bytecode analysis and execution for modern development.
