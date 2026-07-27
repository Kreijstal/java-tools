# Java compiler

`java-tools` includes a Java-source compiler implemented in JavaScript. It uses
the repository lexer, parser, semantic model, Java IR, JVM bytecode IR, Jasmin
assembler, and class-file writer. It does not invoke host `javac` and it does not
fall back to `javac` when a construct is unsupported.

## Command line

Compile one or more files with `scripts/compileJava.js`:

```bash
node scripts/compileJava.js src/example/Main.java --out build/classes
node scripts/compileJava.js src/example/Main.java src/example/Helper.java \
  --out build/classes --source-level 8
```

The equivalent npm entry point is:

```bash
npm run compile:java -- src/example/Main.java --out build/classes
```

Options:

- `--out <directory>` or `-d <directory>` selects the class-file output root.
- `--source-level <number>` selects the parser source level.
- `--help` prints the command reference.

Package names become directories below the output root. A source file may emit
multiple class files for nested, anonymous, or enum-constant classes.

The compiler command is separate from `scripts/jvm-cli.js`; there is currently
no `jvm-cli.js compile` subcommand.

## JavaScript API

The public frontend module exports source, file, AST, and batch entry points:

```javascript
const frontend = require("../src/java-frontend");

const result = frontend.compileJavaSource(`
package example;

public final class Main {
    public static void main(String[] args) {
        System.out.println("Hello");
    }
}
`, {
    sourceFileName: "Main.java",
    sourceLevel: 8,
    outputDir: "build/classes"
});

console.log(result.status);
console.log(result.classes[0].internalName);
console.log(result.classes[0].jasmin);
```

For related source files, compile them as one batch so name and descriptor
resolution can see every input:

```javascript
const result = frontend.compileJavaFiles([
    "src/example/Main.java",
    "src/example/Helper.java"
], {
    sourceRoot: "src",
    outputDir: "build/classes",
    sourceLevel: 8
});
```

Important result fields include:

- `status`: `complete` or `partial`;
- `classes`: emitted class metadata and canonical Jasmin;
- `written`: class-file paths written under `outputDir`;
- `javaIr`: the serializable Java intermediate representation;
- `bytecodeIr`: the serializable JVM bytecode representation;
- `classFileModel`: the serializable class-file model;
- `unsupported`: unsupported lowering diagnostics.

The normal compiler entry points fail before writing an invalid partial body.
Unsupported syntax is reported as `UnsupportedJavaSyntaxError` with the
responsible compiler phase.

## Browser API

The browser bundle exposes single-source compilation:

```javascript
const result = window.JVMDebug.javaTools.compileJava(source, {
    sourceFileName: "Main.java",
    sourceLevel: 8
});

const mainClass = result.artifacts[0];
console.log(mainClass.internalName);
console.log(mainClass.jasmin);
console.log(mainClass.bytes);
```

For multiple files, initialize the browser workspace and compile paths from it:

```javascript
const debug = new window.JVMDebug.BrowserJVMDebug();
await debug.initialize({ workspace: true });

debug.writeWorkspaceFile("/src/example/Helper.java", helperSource);
debug.writeWorkspaceFile("/src/example/Main.java", mainSource);

const result = debug.compileWorkspace([
    "/src/example/Helper.java",
    "/src/example/Main.java"
], {
    sourceRoot: "/src",
    outputDir: "/classes",
    sourceLevel: 8
});
```

The workbench’s Java view uses this workspace API. See
[workbench.md](workbench.md) for the user-facing workflow.

## Supported input and limitations

The compiler regression suite compiles all Java sources checked into
`sources/`, `examples/sources/java/`, and the CFR expected-output fixtures
without host-compiler fallback. This includes ordinary classes, interfaces,
control flow, exceptions, arrays, nested classes, and the enum lowering covered
by that corpus.

This is not a promise of complete `javac` compatibility. The parser can retain
some unsupported syntax for analysis even when bytecode lowering cannot emit
it. Compilation deliberately fails fast when Java IR or JVM bytecode lowering
cannot represent an input. Use a focused regression test when extending the
supported language surface.

Run compiler tests with:

```bash
node node_modules/tape/bin/tape \
  test/javaFrontendHelloWorldCompile.test.js \
  test/javaFrontendAllJavaCompile.test.js
```

Internal AST, CFG, pass, and sidecar formats are described in
[`src/java-frontend/README.md`](../src/java-frontend/README.md).
