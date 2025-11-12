# JVM Tooling, MCP Server, and LSP Plan

## Unified CLI

`scripts/jvm-cli.js` centralizes assembly, disassembly, linting/optimization, and structural refactors for both `.j` and `.class` files. Highlights:

- `assemble`/`disassemble` convert between Jasmin and bytecode without depending on Krakatau’s Java tools.
- `lint`/`optimize` run the dead-handler eliminator; `--fix` rewrites the file, `-n/--dry-run` shows a unified diff.
- `format` reassembles/disassembles `.j` sources to enforce a canonical layout (same defaults used by the forthcoming LSP formatter).
- `rename-class`/`rename-method` patch both definitions and call sites; they understand descriptors and emit diffs.
- `workspace` subcommands query any classpath (default `sources`) for methods, fields, constants, class descriptors, and reference graph lookups.

All mutating commands accept `--out` to redirect writes and `-n/--dry-run` to preview a diff without touching the inputs.

## Workspace TUI

`scripts/jvm-tui.js` renders a keyboard-driven tree of the current workspace via `blessed`. Use the arrow keys or `j/k` to navigate, press `Enter` to inspect a class, and `q` to exit. Pass `--classpath <dir${path.delimiter}dir2>` to browse alternate trees.

## MCP Server (JSON-RPC over stdio)

Launch with:

```bash
node scripts/mcp-server.js
```

Each JSON-RPC request/response is newline-delimited. The server currently exposes:

- `disassemble { file }` → `{ text }`
- `assemble { file, out? }` → `{ outPath }`
- `lintDeadCode { file, fix?, out? }` → `{ changed, diff?, diagnostics?, outPath? }`
- `renameClass { file, from, to, fix?, out? }`
- `renameMethod { file, className, from, to, descriptor?, fix?, out? }`
- `workspace.listMethods|listFields|listConstants|describeClass|findReferences`
- `workspace.listClasses` (sorted flat list) and `workspace.classTree` (hierarchical structure for TUIs/clients)

All workspace calls accept `classpath`, either as an array or as a delimited string (defaults to `['sources']`). File-orientated commands accept both `.j` and `.class` inputs, automatically producing a unified diff when changes are detected; when `fix` is omitted they operate in preview-only mode.

## LSP & Diagnostics Plan

The in-process harness in `src/lsp/inProcessHarness.js` lets us spin up an LSP-compatible server without spawning child processes. The MCP server’s operations map directly onto the features we plan to expose via LSP:

1. **Diagnostics** — `lintDeadCode` already returns structured diagnostics and a suggested diff; surface these via the LSP’s `textDocument/publishDiagnostics`, carrying the diff in diagnostic data for quick fixes.
2. **Code Actions** — tie diagnostics to code-action providers that call the same MCP endpoints with `fix: true`. For multi-file refactors (renames), use the workspace reference graph from `KrakatauWorkspace`.
3. **Workspace Symbols & Navigation** — reuse `workspace.listMethods`, `workspace.listFields`, `workspace.listClasses`, and `workspace.findReferences` for `workspace/symbol`, `textDocument/documentSymbol`, and `textDocument/references`.
4. **Auto-fix Suggestions** — dead-code optimizations can surface as auto-fixable diagnostics both in the CLI (`-n` diffs) and in editors; future passes (constant folding, verifier hints) can follow the same shape.

Because all heavy lifting lives in plain JS modules (parser, CFG builder, optimizer, renamers), the LSP server can share code with the CLI/MCP server without bundlers. The same primitives also power CLI-based workflows, ensuring feature parity between headless pipelines (CI, MCP clients) and editor integrations.

For client authors and protocol implementers, see `docs/lsp.md` for the detailed request/response breakdown, sample payloads, and configuration knobs exposed during the LSP handshake.
