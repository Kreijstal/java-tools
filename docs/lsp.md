# LSP Integration Guide

This document explains how the JVM tools expose Language Server Protocol (LSP) features and how an editor or external client can integrate with them. The server follows the standard [Language Server Protocol](https://microsoft.github.io/language-server-protocol/specification) over JSON-RPC 2.0 and reuses the same analysis passes exposed via the CLI/MCP server (dead-code diagnostics, structural refactors, workspace queries).

The canonical implementation lives in the repository’s forthcoming `scripts/lsp-server.js` entry point and shares code with the in-process harness (`src/lsp/inProcessHarness.js`) that our unit tests use. This guide focuses on the protocol surface so client authors can start wiring up their editors even before we ship polished binaries.

## Transport & Lifecycle

- **Transport:** stdio with `Content-Length` headers, identical to every other LSP server.
- **Initialization:** send the standard `initialize` request followed by `initialized`. Include any configuration data under `initializationOptions` (see below).
- **Shutdown:** use `shutdown` and `exit`.

Example initialization request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": { "name": "MyEditor" },
    "rootUri": "file:///home/user/project",
    "initializationOptions": {
      "classpath": ["sources", "examples"],
      "jvmCliPath": "scripts/jvm-cli.js"
    },
    "capabilities": {
      "textDocument": {
        "synchronization": { "willSave": false },
        "publishDiagnostics": { "relatedInformation": true },
        "codeAction": { "codeActionLiteralSupport": true },
        "rename": { "prepareSupport": true }
      },
      "workspace": { "symbol": { "symbolKind": { "valueSet": [1, 12] } } }
    }
  }
}
```

Initialization options:

| Option           | Type             | Description |
| ---------------- | ---------------- | ----------- |
| `classpath`      | `string[]`       | Roots to scan for `.class` files (defaults to `["sources"]`). Mirrors `--classpath` in the CLI/MCP server. |
| `jvmCliPath`     | `string`         | Absolute/relative path to `scripts/jvm-cli.js`; used when shelling out for heavyweight transformations. |
| `mcpServerPath`  | `string` _(opt)_ | Path to `scripts/mcp-server.js` if the client wants the LSP to delegate certain operations to the MCP JSON-RPC server. |
| `diagnostics.fixOnSave` | `boolean` _(opt)_ | Enable auto-fix when `textDocument/willSaveWaitUntil` is supported; defaults to `false`. |

The server replies with capabilities roughly equivalent to:

```json
{
  "capabilities": {
    "textDocumentSync": 2,
    "codeActionProvider": { "resolveProvider": false },
    "renameProvider": { "prepareProvider": true },
    "documentFormattingProvider": true,
    "documentSymbolProvider": true,
    "workspaceSymbolProvider": true,
    "referencesProvider": true,
    "executeCommandProvider": {
      "commands": [
        "jvm.applyDeadCodeFix",
        "jvm.renameClass",
        "jvm.renameMethod",
        "jvm.disassembleSelection",
        "jvm.assembleBuffer"
      ]
    }
  }
}
```

## Text Document Flow

1. **Open:** send `textDocument/didOpen` with the full `.j` or `.class` contents. For `.class` files, the server disassembles on the fly (using the same logic as `scripts/jvm-cli.js disassemble`).
2. **Incremental updates:** use `textDocument/didChange` with full-document sync (the server advertises `TextDocumentSyncKind.Full`).
3. **Diagnostics:** after each change, the server runs `runDeadCodePass` on the in-memory AST. Diagnostics look like:

```json
{
  "uri": "file:///MisplacedCatch.j",
  "diagnostics": [
    {
      "range": { "start": { "line": 5, "character": 0 }, "end": { "line": 7, "character": 12 } },
      "severity": 2,
      "code": "dead-handler",
      "message": "Dead handler/jump detected; handler body can be simplified.",
      "data": {
        "fixCommand": "jvm.applyDeadCodeFix",
        "diff": "@@ ... (unified diff omitted for brevity)"
      }
    }
  ]
}
```

Clients can surface the diff to users or execute the referenced command to auto-fix.

## Formatting

The server advertises `textDocument/formatting` (full-document only). When requested, it reassembles the buffer using the same pipeline as `node scripts/jvm-cli.js format`:

1. Parse the `.j` text via the Krakatau-compatible parser.
2. Assemble it to bytecode to ensure verifier-correct ordering.
3. Disassemble back to Jasmin using `unparseDataStructures`, which enforces canonical indentation, label spacing, and attribute layout.

Requests follow the standard shape:

```json
{
  "textDocument": { "uri": "file:///MisplacedCatch.j" },
  "options": { "tabSize": 4, "insertSpaces": true }
}
```

Formatting currently ignores client-specific indentation settings; instead it produces the canonical layout (tabs for directives, 4-space instruction columns) so that CLI, MCP, and LSP workflows stay consistent. Existing `;` comments and blank comment-only lines are preserved by tracking their positions relative to the normalized code.

## Code Actions & Commands

- **`textDocument/codeAction`:** When invoked for a diagnostic with `code === "dead-handler"`, the server returns a `CodeAction` that references `command: "jvm.applyDeadCodeFix"` alongside the file URI and current buffer version. Clients may invoke the command immediately or present it as a quick fix.
- **`workspace/executeCommand`:** Available commands mirror the MCP server:
  - `jvm.applyDeadCodeFix` → Applies dead-code eliminator; returns workspace edits derived from the diff.
  - `jvm.renameClass` → Renames class references inside the current file; expects `{ uri, from, to }`.
  - `jvm.renameMethod` → Renames a method and its call sites in the current file; expects `{ uri, className, from, to, descriptor? }`.
  - `jvm.disassembleSelection` / `jvm.assembleBuffer` are utility commands for clients that want to show raw bytecode/Jasmin snippets.

Internally the server delegates to the same helpers used by the CLI (`runDeadCodePass`, `renameClassAst`, `renameMethodAst`) to keep behavior consistent.

## Navigation Features

| LSP Request | Backing Implementation | Notes |
| ----------- | --------------------- | ----- |
| `textDocument/documentSymbol` | `KrakatauWorkspace.listMethods/fields` | Returns both method and field symbols grouped by class. |
| `workspace/symbol` | `workspace.listClasses` + symbol search | Allows cross-project symbol search by class/method name. |
| `textDocument/references` | `KrakatauWorkspace.findReferences` | Requires classpath indexing; results include class+AST path. |
| `textDocument/rename` | Combination of workspace rename + file-level transforms | For cross-file renames the server updates every affected URI and emits WorkspaceEdits. |

Clients that only care about `.j` buffers can choose to implement a minimal subset (diagnostics + quick fixes) by watching for diagnostics with `data.diff`.

## Working with `.class` Files

When a `.class` document is opened, the server disassembles it to Jasmin internally and tracks a virtual buffer. Diagnostics and code actions refer to the synthesized `.j` text. On save/apply-edits, the server re-assembles the modified AST back into bytecode using `writeClassAstToClassFile`. Clients do not need to handle the conversion themselves.

## Testing & Harness

Use `src/lsp/inProcessHarness.js` to exercise the protocol surface without setting up a full LSP transport. The harness lets you:

```javascript
const { createInProcessLspHarness } = require('../src/lsp/inProcessHarness');
const harness = createInProcessLspHarness({ createServer });
await harness.initialize();
await harness.notify('textDocument/didOpen', { /* ... */ });
const diagnostics = harness.getNotifications();
```

Our `test/lspHarness.test.js` file shows how diagnostics, code actions, and command executions are expected to behave.

## Summary Checklist for Client Authors

1. Spawn the server (`node scripts/lsp-server.js`) with the project root as the working directory.
2. Send a standard `initialize` request with `classpath` under `initializationOptions` if you need non-default lookups.
3. Use full-document synchronization (`didOpen` + `didChange` with the entire text).
4. Surface diagnostics tagged with `dead-handler` and present the provided quick fix (`jvm.applyDeadCodeFix`).
5. Wire `textDocument/rename`, `documentSymbol`, `workspace/symbol`, and `textDocument/references` if your editor supports them.
6. (Optional) expose the custom commands directly via command palettes to let users run refactors or disassemble buffers on demand.

Following these conventions ensures that your client experiences the same behavior as the CLI, MCP server, and automated tests, with zero editor-specific logic baked into the tools themselves.
