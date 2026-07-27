# Browser workbench

The Java Tools Workbench is the browser UI for opening, editing, compiling,
assembling, disassembling, running, and debugging Java programs.

Build and serve it with:

```bash
npm run build
npm run serve
```

Then open <http://localhost:3000/>. The server listens on `0.0.0.0` by default.
Set `PORT` or `HOST` to override either value.

## Files and the browser workspace

The workbench uses an in-memory ZenFS workspace. It is shared by the editor,
compiler, class loader, runner, and debugger for the lifetime of the page.
Reloading the page clears it.

Use the **File** menu to:

- create a Java source file;
- create a folder, including nested paths such as `/src/example/model`;
- open a local `.java`, `.j`, `.class`, or `.jar` file;
- save the active document;
- save a copy under another format or name;
- close the active document.

The **Project files** menu displays `/src`, `/assembly`, `/classes`, and
top-level directories created in the current session. Empty directories remain
visible. Selecting a Java, Jasmin, or class file in the tree opens it.

The document tabs are the source of truth for which file is active. Tool views
do not implicitly reuse unrelated source from another document.

## Class files and Jasmin

Opening `Hello.class` creates a class-backed `Hello.j` document. The text is the
canonical Jasmin disassembly of the class; the original class path remains the
document’s backing file.

For a class-backed `.j` document:

- **Save** or `Ctrl+S` assembles the edited Jasmin and replaces the backing
  `.class` in the browser workspace.
- **Revert** reloads the current backing class.
- **Save As…** with a `.class` name assembles a downloadable class file.
- **Save As…** with a `.j` name downloads and retains the exact text, including
  comments and directives, as an ordinary assembly document.

Class files cannot store arbitrary Jasmin comments or presentation metadata.
Use `.j` when exact source-text preservation matters.

The **Assembly** view includes a class and method browser. The standalone CLI
workflow is documented in [tooling.md](tooling.md).

## Java view

Opening Java source creates an editable Java document under `/src`.

When a class-backed `.j` document is active and you select **Java**, the
workbench decompiles that class and selects its linked Java representation.
Both representations share one logical document tab: its label changes from
`.j` to `.java` as the tool view changes, and closing it closes both buffers.
For example:

```text
Hello.class → Hello.j → Hello.java
```

Opening a second class creates or selects that second class’s Java document; it
does not leave the first class’s Java source in the editor. Unsaved edits in an
already-linked Java document are preserved.

Use:

- **Compile source** to emit class files under `/classes` and inspect emitted
  Jasmin;
- **Compile & Run** to compile, load, and execute the selected Java document;
- **Download .class** to export the selected compiler artifact;
- **Load into JVM** to inspect or debug the selected compiler artifact.

Compiler details and APIs are in [compiler.md](compiler.md).

There is no separate Decompile tab. Decompilation is the transition from an
active class-backed `.j` document to its Java representation. This avoids a
second read-only Java buffer that can drift away from the active file.

Decompilation and compilation are still different operations internally.
Decompiled output can expose compiler bugs or unsupported source constructs;
successful decompilation does not guarantee successful recompilation.

## Run view

Applications use the xterm.js terminal. Applets use the browser AWT canvas.
The workbench selects a surface from the loaded class’s launch metadata, and the
surface toggle can override the visible pane.

Run and Debug are separate actions:

- **Run** executes without stopping at the first instruction.
- **Debug** starts paused and exposes stepping and state inspection.

## Debug view

The Debug view contains:

- the current bytecode and highlighted instruction;
- continue, pause, stepping, rewind, breakpoint, and state controls;
- the active thread selector;
- operand stack, local variables, and call stack inspectors;
- the same live xterm.js terminal used by Run.

Before a session starts, the thread selector reads **No active threads** and is
disabled. Once threads exist, it becomes selectable.

Run and Debug move the same xterm instance between their views, so terminal
output and input state are not duplicated or lost.

The program-counter breakpoint control currently accepts a numeric bytecode PC.
See [`DEBUG_API.md`](../DEBUG_API.md) for the JavaScript API and current stepping
limitations.

## JAR files and built-in samples

Opening a JAR extracts classes and resources into the browser classpath. A
manifest `Main-Class` is selected when present; otherwise choose a runnable
class from the entry-class selector.

Built-in samples are grouped by category. Only classes with a runnable
application or applet entry point appear in the primary sample chooser. Support
classes remain available through the Assembly class browser.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` / `Cmd+N` | New Java file |
| `Ctrl+O` / `Cmd+O` | Open file |
| `Ctrl+S` / `Cmd+S` | Save active document |
| `Ctrl+Shift+S` / `Cmd+Shift+S` | Save As |
| `Ctrl+W` / `Cmd+W` | Close active document |

## Browser regression tests

The focused workbench suite covers file tabs, class-to-Java association,
assembly saving, directory creation, compilation, running, debugging, terminal
docking, and JAR loading:

```bash
npx playwright test tests/playwright/workbench-interface.spec.js \
  --project=chromium
```
