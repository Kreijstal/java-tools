# Assembler and disassembler

`java-tools` includes a JavaScript class disassembler and Jasmin assembler. They
do not invoke Krakatau, Jasmin, `javap`, or another Java process.

The text format is the repository’s canonical Krakatau/Jasmin-style `.j`
representation. A disassembled class can be edited and assembled back into a
binary `.class`.

## Disassemble a class

```bash
node scripts/jvm-cli.js disassemble build/classes/example/Main.class
```

Without an output option, this writes `build/classes/example/Main.j`.

Choose a path or write to standard output:

```bash
node scripts/jvm-cli.js disassemble Main.class --out /tmp/Main.j
node scripts/jvm-cli.js disassemble Main.class --stdout
```

Add caller, field-reference, purity, and throws annotations from a surrounding
classpath:

```bash
node scripts/jvm-cli.js disassemble Main.class \
  --xref-classpath "build/classes:lib" \
  --out Main.j
```

Use the platform path delimiter (`:` on Unix-like systems, `;` on Windows).
Cross-reference annotations are presentation comments; they are not JVM
class-file attributes.

`disassemble` supports `--out`, `-o`, `--stdout`, and `--xref-classpath`. It
does not support `--dry-run`.

## Assemble Jasmin

```bash
node scripts/jvm-cli.js assemble Main.j
```

Without an output option, this writes `Main.class` beside `Main.j`.

Choose an output path with:

```bash
node scripts/jvm-cli.js assemble Main.j --out build/classes/Main.class
```

`assemble` supports `--out`/`-o`. It does not support `--stdout` or
`--dry-run`.

The assembler validates syntax and converts the parsed text to the repository
class AST before writing the class file. Unsupported or inconsistent directives
fail the command instead of silently producing a partial class.

## Canonical formatting

`format` assembles and disassembles a `.j` file to canonicalize its layout:

```bash
node scripts/jvm-cli.js format Main.j -n
node scripts/jvm-cli.js format Main.j --out Main.formatted.j
```

Unlike `assemble` and `disassemble`, `format` supports `-n/--dry-run` because it
is a source-text rewrite and can show a unified diff.

Class files do not preserve arbitrary `.j` comments or source formatting. A
format or `.j → .class → .j` round trip preserves class-file semantics, not
exact presentation text.

## Node.js API

```javascript
const fs = require("fs");
const {
    assembleJasminBytes,
    assembleJasminFile,
    disassembleClassFile
} = require("./src/utils/jasminAssembly");

const bytes = assembleJasminBytes(jasminText);
fs.writeFileSync("Main.class", bytes);

assembleJasminFile("Main.j", "Main.class");

const text = disassembleClassFile("Main.class");
console.log(text);
```

Lower-level exports:

- `parseJasminSource(text)` returns the repository class AST;
- `assembleJasminSource(text, outputPath, options?)` writes a class;
- `assembleJasminBytes(text, options?)` returns class bytes;
- `assembleJasminFile(inputPath, outputPath?, options?)` assembles a file;
- `parseClassFile(path)` returns parsed and converted class data;
- `disassembleClassFile(path, options?)` returns canonical `.j` text.

## Browser API and workbench

```javascript
const bytes = window.JVMDebug.javaTools.assembleJasmin(jasminText);
const jasmin = debug.getClassDisassembly(bytes);
```

In the browser workbench, opening `Main.class` presents a class-backed `Main.j`
document. Saving it assembles and replaces its backing class in the browser
workspace. Save As `.j` when exact comments and source formatting must remain
text. See [workbench.md](workbench.md).

## Round-trip check

Use a temporary output directory so the check does not overwrite sources:

```bash
node scripts/jvm-cli.js assemble Main.j --out /tmp/Main.class
node scripts/jvm-cli.js disassemble /tmp/Main.class --out /tmp/Main.j
```

The repository tests cover assembler/disassembler round trips, class metadata,
exception tables, stack maps, and class-file parsing. The broader CLI and
analysis commands are described in [tooling.md](tooling.md).
