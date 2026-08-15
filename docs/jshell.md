# Interactive Java shell

`java-tools` includes an interactive Java snippet runner implemented with its
own JavaScript compiler and JVM. It does not spawn `javac`, `java`, or the JDK
`jshell` command.

Start an interactive session:

```bash
npm run jshell
```

The installed command name is also `java-tools-jshell`:

```bash
npx java-tools-jshell
```

Declarations and execution share one JVM:

```text
jshell> int value = 7;
|  created variable value
jshell> value
7
jshell> value += 5;
jshell> int twice(int input) { return input * 2; }
|  created method twice
jshell> twice(value)
24
```

Each accepted declaration is compiled into a new snippet class. That class
extends the previous snippet class, while the same `JVM` object executes every
snippet. Java inheritance provides source-level visibility and the JVM retains
the real static field values. The shell disables source-metadata caching for
these incremental compilations so a newly accepted field, method, or nested type
is visible immediately.

Expressions print their result. Statements execute without an additional
result line. Top-level field, method, and type declarations persist; local
variables declared inside a statement block do not.
Field declarations and imports may omit their trailing semicolon.

## Commands

- `/list` lists all accepted snippets.
- `/vars`, `/methods`, `/types`, and `/imports` filter that list.
- `/reset` creates a fresh compiler workspace and JVM.
- `/save FILE` saves the accepted snippet transcript.
- `/help` prints the command reference.
- `/exit` closes the session.

Balanced braces, parentheses, and brackets may span multiple input lines.
Delimiters inside strings and comments do not prematurely complete a snippet.

## Non-interactive use

Input can be piped into the same CLI:

```bash
printf 'int value = 20;\nvalue + 22\n/exit\n' | npm run jshell -- --no-jit
```

Options:

- `--class-path <paths>` adds platform-delimited classpath roots.
- `--source-level <number>` selects the Java parser source level (default 8).
- `--no-jit` disables generated JVM execution.
- `--verbose` enables JVM diagnostics.
- `--keep-workspace` preserves generated `.java` and `.class` files.

A piped session exits nonzero if any snippet fails, while continuing to read
later input so a batch can report more than one error.

## Node.js API

```javascript
const { JShellSession } = require("../src/jshell/JShellSession");

const session = new JShellSession({ jit: false });
try {
  await session.evaluate("int value = 21;");
  await session.evaluate("System.out.println(value * 2);");
} finally {
  session.close();
}
```

`evaluate(source)` returns the accepted snippet kind and generated artifacts.
`list(kind)` returns session history, `reset()` clears both compiler and runtime
state, and `close()` removes the temporary workspace unless
`keepWorkspace: true` was selected.

## Scope

This is a practical shell for the Java subset supported by the repository
compiler, not a complete clone of JDK JShell. In particular, it does not yet
create `$1`-style scratch variables for expression results, provide completion
or source documentation, edit/drop individual snippets, or redefine running
method bodies in place. Unsupported Java syntax is reported by the normal
compiler diagnostics.
