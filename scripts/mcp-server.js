#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createTwoFilesPatch } = require('diff');
const { parseKrak2Assembly } = require('../src/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');
const { convertJson, unparseDataStructures } = require('../src/convert_tree');
const { getAST } = require('jvm_parser');
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const { SymbolIdentifier } = require('../src/symbols');
const { runDeadCodePass } = require('../src/deadCodePass');
const { renameClassAst, renameMethodAst } = require('../src/astTransforms');
const { inlineSinglePredecessorBlocks } = require('../src/blockInliner');
const { relocateTrivialHandlers } = require('../src/handlerRelocator');
const { computeMethodEffects } = require('../src/methodEffectsAnalyzer');
const { collectMethodCallers } = require('../src/callGraphMetadata');
const { collectFieldReferences } = require('../src/fieldReferenceMetadata');

const jsonrpc = {
  success(id, result) {
    return { jsonrpc: '2.0', id, result };
  },
  error(id, error) {
    return { jsonrpc: '2.0', id, error };
  },
};

const JsonRpcError = {
  internalError(message) {
    return { code: -32603, message };
  },
};

function disassemble(file) {
  const classBytes = fs.readFileSync(file);
  const parsed = getAST(new Uint8Array(classBytes));
  const converted = convertJson(parsed.ast, parsed.constantPool);
  return unparseDataStructures(converted.classes[0], parsed.constantPool);
}

function assemble(text, outPath) {
  const ast = convertKrak2AstToClassAst(parseKrak2Assembly(text), { sourceText: text });
  writeClassAstToClassFile(ast, outPath);
}

function generateJasmin(astRoot, constantPool) {
  if (!astRoot || !astRoot.classes) return '';
  return astRoot.classes
    .map((cls) => unparseDataStructures(cls, constantPool))
    .join('\n');
}

function loadArtifact(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.j') {
    const text = fs.readFileSync(file, 'utf8');
    const ast = convertKrak2AstToClassAst(parseKrak2Assembly(text), { sourceText: text });
    return {
      format: 'jasmin',
      astRoot: ast,
      constantPool: null,
      baseline: text,
      write(targetPath = file) {
        fs.writeFileSync(targetPath, generateJasmin(ast, null), 'utf8');
        return targetPath;
      },
    };
  }
  if (ext === '.class') {
    const classBytes = fs.readFileSync(file);
    const parsed = getAST(new Uint8Array(classBytes));
    const astRoot = convertJson(parsed.ast, parsed.constantPool);
    return {
      format: 'class',
      astRoot,
      constantPool: parsed.constantPool,
      baseline: generateJasmin(astRoot, parsed.constantPool),
      write(targetPath = file) {
        writeClassAstToClassFile(astRoot, targetPath);
        return targetPath;
      },
    };
  }
  throw new Error(`Unsupported file type: ${file}`);
}

const workspaceCache = new Map();

async function getWorkspace(classpath = ['sources']) {
  const key = classpath.join(path.delimiter);
  if (!workspaceCache.has(key)) {
    workspaceCache.set(key, await KrakatauWorkspace.create(classpath));
  }
  return workspaceCache.get(key);
}

function normalizeClasspath(value) {
  if (!value) return ['sources'];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.length ? value.split(path.delimiter) : ['sources'];
  }
  throw new Error('classpath must be a string or array');
}

function buildWorkspaceAst(workspace) {
  const classes = [];
  Object.values(workspace.workspaceASTs || {}).forEach((entry) => {
    if (!entry || !entry.ast || !Array.isArray(entry.ast.classes)) {
      return;
    }
    entry.ast.classes.forEach((cls) => classes.push(cls));
  });
  return { classes };
}

function compareMethodRefs(a, b) {
  if (a.className !== b.className) {
    return a.className.localeCompare(b.className);
  }
  if (a.methodName !== b.methodName) {
    return a.methodName.localeCompare(b.methodName);
  }
  return (a.descriptor || '').localeCompare(b.descriptor || '');
}

function compareFieldRefs(a, b) {
  if (a.className !== b.className) {
    return a.className.localeCompare(b.className);
  }
  if (a.methodName !== b.methodName) {
    return a.methodName.localeCompare(b.methodName);
  }
  if ((a.descriptor || '') !== (b.descriptor || '')) {
    return (a.descriptor || '').localeCompare(b.descriptor || '');
  }
  return (a.op || '').localeCompare(b.op || '');
}

function buildClassTree(workspace) {
  const root = {};
  Object.keys(workspace.workspaceASTs).forEach((className) => {
    const parts = className.split('/');
    let node = root;
    parts.forEach((part, index) => {
      node.children = node.children || {};
      node.children[part] = node.children[part] || {};
      node = node.children[part];
      if (index === parts.length - 1) {
        node.className = className;
      }
    });
  });
  return formatTreeChildren(root);
}

function formatTreeChildren(node) {
  if (!node.children) return [];
  return Object.entries(node.children)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => ({
      name,
      className: child.className || null,
      children: formatTreeChildren(child),
    }));
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  try {
    switch (method) {
      case 'disassemble': {
        const result = disassemble(params.file);
        return jsonrpc.success(id, { text: result });
      }
      case 'assemble': {
        const text = fs.readFileSync(params.file, 'utf8');
        const out = params.out || params.file.replace(/\.j$/i, '.class');
        assemble(text, out);
        return jsonrpc.success(id, { outPath: out });
      }
      case 'lintDeadCode': {
        const artifact = loadArtifact(params.file);
        const inlineResult = inlineSinglePredecessorBlocks(artifact.astRoot);
        const inlineDiagnostics = inlineResult.merges.map((merge) => ({
          className: merge.className,
          methodName: merge.methodName,
          descriptor: merge.descriptor,
          message: `Inlined unique-target block ${merge.label} into its predecessor.`,
        }));
        const relocation = relocateTrivialHandlers(artifact.astRoot);
        const relocationDiagnostics = relocation.relocations.map((reloc) => ({
          className: reloc.className,
          methodName: reloc.methodName,
          descriptor: reloc.descriptor,
          message: `Relocated trivial handler ${reloc.handlerLabel} to the method epilogue.`,
        }));
        const methodEffects = computeMethodEffects(artifact.astRoot);
        const { diagnostics: deadCodeDiagnostics, changed: dceChanged } = runDeadCodePass(
          artifact.astRoot,
          { methodEffects },
        );
        const allDiagnostics = inlineDiagnostics
          .concat(relocationDiagnostics)
          .concat(deadCodeDiagnostics);
        const changed = inlineResult.changed || relocation.changed || dceChanged;
        if (params.fix && changed) {
          const outPath = params.out || params.file;
          artifact.write(outPath);
          const after = generateJasmin(artifact.astRoot, artifact.constantPool);
          const diff = createTwoFilesPatch(params.file, params.file, artifact.baseline, after, '', '');
          return jsonrpc.success(id, { changed, outPath, diff, diagnostics: allDiagnostics });
        }
        if (changed) {
          const after = generateJasmin(artifact.astRoot, artifact.constantPool);
          const diff = createTwoFilesPatch(params.file, params.file, artifact.baseline, after, '', '');
          return jsonrpc.success(id, { changed, diff, diagnostics: allDiagnostics });
        }
        return jsonrpc.success(id, { changed: false, diagnostics: allDiagnostics });
      }
      case 'renameClass': {
        if (!params.file) throw new Error('file required');
        if (!params.from) throw new Error('from required');
        if (!params.to) throw new Error('to required');
        const artifact = loadArtifact(params.file);
        const changed = renameClassAst(artifact.astRoot, params.from, params.to);
        if (!changed) {
          return jsonrpc.success(id, { changed: false });
        }
        const after = generateJasmin(artifact.astRoot, artifact.constantPool);
        const diff = createTwoFilesPatch(params.file, params.file, artifact.baseline, after, '', '');
        if (params.fix) {
          const outPath = artifact.write(params.out || params.file);
          return jsonrpc.success(id, { changed: true, diff, outPath });
        }
        return jsonrpc.success(id, { changed: true, diff });
      }
      case 'renameMethod': {
        if (!params.file) throw new Error('file required');
        if (!params.className) throw new Error('className required');
        if (!params.from) throw new Error('from required');
        if (!params.to) throw new Error('to required');
        const artifact = loadArtifact(params.file);
        const changed = renameMethodAst(
          artifact.astRoot,
          params.className,
          params.from,
          params.to,
          params.descriptor,
        );
        if (!changed) {
          return jsonrpc.success(id, { changed: false });
        }
        const after = generateJasmin(artifact.astRoot, artifact.constantPool);
        const diff = createTwoFilesPatch(params.file, params.file, artifact.baseline, after, '', '');
        if (params.fix) {
          const outPath = artifact.write(params.out || params.file);
          return jsonrpc.success(id, { changed: true, diff, outPath });
        }
        return jsonrpc.success(id, { changed: true, diff });
      }
      case 'workspace.listMethods': {
        if (!params.className) throw new Error('className required');
        const classpath = normalizeClasspath(params.classpath);
        const workspace = await getWorkspace(classpath);
        const methods = workspace.listMethods(params.className).map((m) => ({
          name: m.identifier.memberName,
          descriptor: m.descriptor,
          flags: m.flags,
        }));
        return jsonrpc.success(id, { methods });
      }
      case 'workspace.listFields': {
        if (!params.className) throw new Error('className required');
        const classpath = normalizeClasspath(params.classpath);
        const workspace = await getWorkspace(classpath);
        const fields = workspace.listFields(params.className).map((f) => ({
          name: f.identifier.memberName,
          descriptor: f.descriptor,
          flags: f.flags,
        }));
        return jsonrpc.success(id, { fields });
      }
      case 'workspace.listConstants': {
        if (!params.className) throw new Error('className required');
        const classpath = normalizeClasspath(params.classpath);
        const workspace = await getWorkspace(classpath);
        const entry = workspace.workspaceASTs[params.className];
        if (!entry || !entry.constantPool) {
          return jsonrpc.success(id, { constants: [] });
        }
        const constants = entry.constantPool.map((value, index) =>
          value ? { index, value } : null,
        );
        return jsonrpc.success(id, { constants });
      }
      case 'workspace.listClasses': {
        const classpath = normalizeClasspath(params.classpath);
        const workspace = await getWorkspace(classpath);
        const classes = Object.keys(workspace.workspaceASTs).sort();
        return jsonrpc.success(id, { classes });
      }
      case 'workspace.classTree': {
        const classpath = normalizeClasspath(params.classpath);
        const workspace = await getWorkspace(classpath);
        const tree = buildClassTree(workspace);
        return jsonrpc.success(id, { tree });
      }
      case 'workspace.methodCallers': {
        if (!params.className) throw new Error('className required');
        const classpath = normalizeClasspath(params.classpath);
        const workspace = await getWorkspace(classpath);
        const astRoot = buildWorkspaceAst(workspace);
        const methods = collectMethodCallers(astRoot)
          .filter((entry) => {
            if (entry.className !== params.className) {
              return false;
            }
            if (params.methodName && entry.methodName !== params.methodName) {
              return false;
            }
            if (params.descriptor && entry.descriptor !== params.descriptor) {
              return false;
            }
            return true;
          })
          .map((entry) => ({
            className: entry.className,
            methodName: entry.methodName,
            descriptor: entry.descriptor,
            callers: (entry.callers || []).slice().sort(compareMethodRefs),
          }));
        return jsonrpc.success(id, { methods });
      }
      case 'workspace.fieldReferences': {
        if (!params.className) throw new Error('className required');
        const classpath = normalizeClasspath(params.classpath);
        const workspace = await getWorkspace(classpath);
        const astRoot = buildWorkspaceAst(workspace);
        const fields = collectFieldReferences(astRoot)
          .filter((entry) => {
            if (entry.className !== params.className) {
              return false;
            }
            if (params.fieldName && entry.fieldName !== params.fieldName) {
              return false;
            }
            if (params.descriptor && entry.descriptor !== params.descriptor) {
              return false;
            }
            return true;
          })
          .map((entry) => ({
            className: entry.className,
            fieldName: entry.fieldName,
            descriptor: entry.descriptor,
            references: (entry.references || []).slice().sort(compareFieldRefs),
          }));
        return jsonrpc.success(id, { fields });
      }
      case 'workspace.describeClass': {
        if (!params.className) throw new Error('className required');
        const classpath = normalizeClasspath(params.classpath);
        const workspace = await getWorkspace(classpath);
        const ast = workspace.getClassAST(params.className);
        const cls = ast.classes[0];
        return jsonrpc.success(id, {
          className: cls.className,
          flags: cls.flags,
          superClass: cls.superClassName,
          interfaces: cls.interfaces,
        });
      }
      case 'workspace.findReferences': {
        if (!params.className) throw new Error('className required');
        const classpath = normalizeClasspath(params.classpath);
        const workspace = await getWorkspace(classpath);
        const identifier = new SymbolIdentifier(params.className, params.memberName, params.descriptor);
        const refs = workspace.findReferences(identifier).map((ref) => ({
          className: ref.className,
          astPath: ref.astPath,
        }));
        return jsonrpc.success(id, { references: refs });
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  } catch (err) {
    return jsonrpc.error(id, JsonRpcError.internalError(err.message));
  }
}

function startServer() {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        continue;
      }
      const response = await handleRequest(msg);
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });
}

startServer();
