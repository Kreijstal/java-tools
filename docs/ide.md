# Browser IDE

The Java Tools IDE is the primary browser UI (`dist/index.html`, deployed to
GitHub Pages). It replaces the view-centric workbench with an IDE-style layout
built on [GoldenLayout](https://golden-layout.com/): draggable, resizable,
tabbed panels like Cloud9 or VS Code. The previous UI remains available at
`dist/classic.html`.

Build and serve:

```bash
npm run build
npm run serve   # http://localhost:3000/
```

## Layout

- **Files** (left): the explorer tree over the shared in-memory workspace.
- **Editor tabs** (center): one tab per file, powered by Ace.
- **Bottom panels**: Terminal (xterm.js), Output (runtime log), Display
  (AWT/applet canvas), Debug (stepping controls and state inspectors),
  Bytecode (disassembly of the class currently loaded in the JVM).

All panels can be re-arranged by dragging their tabs.

On phones and small tablets (viewport ≤ 768px, or coarse pointer ≤ 1024px)
GoldenLayout is replaced by a mobile layout: a horizontal view switcher
(Files, Editor, Terminal, …) showing one fullscreen view at a time, with a
tab strip for open editors. The same explorer, documents, and actions run in
both layouts (`src/platform/ide/mobileLayout.js`).

## File model: one file, one tab

`.java`, `.j`, and `.class` are ordinary, distinct files. A tab never changes
which file it shows (the classic workbench's `Hello.class → Hello.j →
Hello.java` shared-tab morphing is gone):

- Opening a `.class` shows a **read-only disassembly view** with actions.
- **Disassemble → .j** writes a real `Foo.j` next to `Foo.class`; edit and
  save it like any file, then **Assemble** to produce the sibling `.class`.
- **Decompile → .java** writes a real `Foo.java` next to the class (it will
  not overwrite an existing file).

## Explorer

The tree shows the whole workspace from `/`, with collapsible directories.

- Click a file to open it; right-click for context actions: compile, run,
  debug, assemble, disassemble, decompile, rename, delete, download, upload.
- New files/folders can be created from the toolbar, the File menu, or a
  directory's context menu. Nested paths like `model/Point.java` work.
- Built-in samples live under `/samples` (still on the classpath).
- Uploading a `.jar`/`.zip` extracts it onto the classpath.

The workspace is in-memory (ZenFS); reloading the page clears it.

## Compilation: javac semantics

Compiling `dir/Foo.java` emits its class files into `dir/` — next to the
source, like `javac`. Packages become subdirectories (like `javac -d dir`).
The IDE registers each output directory as a *classpath root*
(`BrowserFileProvider.addClasspathRoot`), so classes are runnable from
wherever they were compiled without copying them to the workspace root.

## Run and debug

**Run** compiles/assembles the active file if needed, picks the runnable
class (main method or applet), and executes it. Terminal programs use the
Terminal panel (with stdin support); applets open in the Display panel.
**Debug** starts paused and reveals the Debug panel: step into/over/out,
instruction stepping, rewind, PC breakpoints, operand stack, locals, and call
stack — the same debugger engine as the classic workbench.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+S` / `Cmd+S` | Save active file |
| `Ctrl+B` / `Cmd+B` | Compile active `.java` (or assemble `.j`) |

## Architecture

- `src/platform/ide.html`, `ide.css` — page shell; copied to `dist/`.
- `src/platform/ide/` — the IDE bundle (webpack → `dist/ide-ui.js`): layout
  (`main.js`), explorer (`explorer.js`), editor tabs (`documents.js`), and
  compile/run/disassemble actions (`actions.js`).
- The JVM runtime layer is unchanged: `jvm-debug.js` (bundle) plus
  `browser-ui-enhancements.js` provide the JVM, xterm bridge, samples, and
  debugger globals; the IDE page includes the DOM ids that layer expects and
  drives it through `window.jvmDebug` / `window.runProgram` / etc.

A possible future direction for the Terminal panel is a real POSIX shell via
[Kandelo](https://github.com/Automattic/kandelo) (POSIX-on-Wasm), which would
let the terminal double as a Unix-like environment over the same workspace.

## Regression tests

```bash
npx playwright test tests/playwright/ide-interface.spec.js --project=chromium
```

covers boot, tree collapse/expand, file creation, javac-style class
placement, the distinct `.java`/`.j` tab model, terminal runs, and sample
loading. The classic workbench suite now runs against `dist/classic.html`.
