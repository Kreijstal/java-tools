'use strict';

const context = require('./context');
const {
  basename,
  parentPath,
  normalizePath,
  joinPath,
  extensionOf,
  setStatus,
  logLine,
} = require('./util');

function jvm() {
  const instance = window.jvmDebug;
  if (!instance) throw new Error('The JVM runtime is still booting');
  return instance;
}

function javaTools() {
  return window.JVMDebug.javaTools;
}

/**
 * The internal (JVM) name of a class file, e.g. `pkg/Main`, parsed from the
 * Krakatau disassembly's `.class` directive.
 */
function internalNameOfClassBytes(bytes) {
  const text = jvm().getClassDisassembly(bytes);
  const match = text.match(/^\s*\.class\b[^\n]*?(\S+)\s*$/m);
  if (!match) throw new Error('Could not determine the class name');
  return match[1];
}

function internalNameOfClassFile(filePath) {
  const bytes = context.workspace.map.get(normalizePath(filePath));
  if (bytes === undefined) throw new Error(`Cannot read ${filePath}`);
  return internalNameOfClassBytes(bytes);
}

/**
 * Register the classpath root that makes `internalName.class` resolvable for
 * a class file stored at `filePath`. For `/src/pkg/Main.class` with internal
 * name `pkg/Main` that root is `/src`; for an unpackaged class it is its own
 * directory.
 */
function registerClasspathRootFor(filePath, internalName) {
  const dir = parentPath(filePath);
  const packagePath = internalName.includes('/')
    ? internalName.slice(0, internalName.lastIndexOf('/'))
    : '';
  let root = dir;
  if (packagePath && dir.endsWith(`/${packagePath}`)) {
    root = dir.slice(0, dir.length - packagePath.length - 1) || '/';
  }
  jvm().fileProvider.addClasspathRoot(root);
  return root;
}

/**
 * Compile a Java source with javac placement semantics: class files are
 * emitted into the source file's own directory (packages become
 * subdirectories, like `javac -d <dir>`).
 */
function compileJavaFile(filePath) {
  const documents = require('./documents');
  const path = normalizePath(filePath);
  documents.flushDocument(path);
  const dir = parentPath(path);
  setStatus(`Compiling ${path}…`, 'info');
  let result;
  try {
    result = jvm().compileWorkspace([path], {
      sourceRoot: dir,
      outputDir: dir,
      sourceLevel: '8',
    });
  } catch (error) {
    setStatus(`Compile failed: ${error.message}`, 'error');
    logLine(`Compile failed for ${path}: ${error.message}`, 'error');
    context.reveal('output');
    throw error;
  }
  for (const artifact of result.artifacts) {
    registerClasspathRootFor(joinPath(dir, `${artifact.internalName}.class`), artifact.internalName);
    logLine(`Emitted ${joinPath(dir, `${artifact.internalName}.class`)} (${artifact.bytes.length} bytes)`, 'success');
  }
  setStatus(
    `Compiled ${path} → ${result.artifacts.length} class file${result.artifacts.length === 1 ? '' : 's'}`,
    'success',
  );
  context.refreshTree();
  for (const artifact of result.artifacts) {
    documents.reloadClassViewer(joinPath(dir, `${artifact.internalName}.class`));
  }
  return result;
}

/** Assemble a Jasmin/Krakatau `.j` file into a sibling `.class`. */
function assembleJasminFile(filePath) {
  const documents = require('./documents');
  const path = normalizePath(filePath);
  documents.flushDocument(path);
  const source = context.workspace.readFileSync(path, 'utf8');
  setStatus(`Assembling ${path}…`, 'info');
  let bytes;
  try {
    bytes = javaTools().assembleJasmin(String(source));
  } catch (error) {
    setStatus(`Assemble failed: ${error.message}`, 'error');
    context.reveal('output');
    throw error;
  }
  const internalName = internalNameOfClassBytes(bytes);
  const simpleName = internalName.includes('/')
    ? internalName.slice(internalName.lastIndexOf('/') + 1)
    : internalName;
  const outPath = joinPath(parentPath(path), `${simpleName}.class`);
  context.workspace.map.set(outPath, bytes);
  registerClasspathRootFor(outPath, internalName);
  setStatus(`Assembled ${outPath}`, 'success');
  context.refreshTree();
  documents.reloadClassViewer(outPath);
  return { outPath, internalName };
}

/** Write the canonical disassembly of a class file to a sibling `.j` file. */
function disassembleClassFile(filePath) {
  const path = normalizePath(filePath);
  const bytes = context.workspace.map.get(path);
  if (bytes === undefined) throw new Error(`Cannot read ${path}`);
  const text = jvm().getClassDisassembly(bytes);
  const outPath = path.replace(/\.class$/, '.j');
  context.workspace.writeFileSync(outPath, text);
  setStatus(`Disassembled to ${outPath}`, 'success');
  context.refreshTree();
  context.openFile(outPath);
  return outPath;
}

/** Decompile a class file to a sibling `.java` file. */
function decompileClassFile(filePath) {
  const path = normalizePath(filePath);
  const bytes = context.workspace.map.get(path);
  if (bytes === undefined) throw new Error(`Cannot read ${path}`);
  setStatus(`Decompiling ${path}…`, 'info');
  const source = javaTools().decompileClass(bytes);
  const outPath = path.replace(/\.class$/, '.java');
  if (context.workspace.existsSync(outPath)) {
    setStatus(`${outPath} already exists — not overwriting`, 'error');
    context.openFile(outPath);
    return outPath;
  }
  context.workspace.writeFileSync(outPath, source);
  setStatus(`Decompiled to ${outPath}`, 'success');
  context.refreshTree();
  context.openFile(outPath);
  return outPath;
}

/** Load a class into the JVM state + bytecode panel without running it. */
async function loadClassFileIntoJvm(filePath) {
  const path = normalizePath(filePath);
  const internalName = internalNameOfClassFile(path);
  registerClasspathRootFor(path, internalName);
  await window.loadVirtualClass(`${internalName}.class`);
  context.reveal('bytecode');
  return internalName;
}

async function launchInternalName(internalName, { debug = false } = {}) {
  const classKey = `${internalName}.class`;
  const info = await jvm().getClassLaunchInfo(classKey);
  await window.loadVirtualClass(classKey);
  if (debug) {
    context.reveal('bytecode');
    context.reveal('debug');
    await window.startDebugging();
  } else {
    context.reveal(info.launchMode === 'applet' ? 'display' : 'terminal');
    await window.runProgram();
  }
}

/** Pick the runnable artifact from a compile result, like Compile & Run. */
async function pickRunnableArtifact(artifacts) {
  let runnable = null;
  for (const artifact of artifacts) {
    const info = await jvm().getClassLaunchInfo(`${artifact.internalName}.class`);
    if (info.launchMode) {
      runnable = artifact;
      if (!artifact.internalName.includes('$')) break;
    }
  }
  return runnable;
}

/** Run (or debug) a workspace file: `.java` compiles first, `.j` assembles first. */
async function runPath(filePath, { debug = false } = {}) {
  const path = normalizePath(filePath);
  const ext = extensionOf(path);
  if (ext === 'java') {
    const result = compileJavaFile(path);
    const runnable = await pickRunnableArtifact(result.artifacts);
    if (!runnable) {
      setStatus('Compiled, but no main method or applet entry point found', 'error');
      return;
    }
    await launchInternalName(runnable.internalName, { debug });
  } else if (ext === 'j') {
    const { internalName } = assembleJasminFile(path);
    await launchInternalName(internalName, { debug });
  } else if (ext === 'class') {
    const internalName = internalNameOfClassFile(path);
    registerClasspathRootFor(path, internalName);
    await launchInternalName(internalName, { debug });
  } else {
    setStatus(`Cannot run ${path} — expected .java, .j, or .class`, 'error');
  }
}

function debugPath(filePath) {
  return runPath(filePath, { debug: true });
}

module.exports = {
  compileJavaFile,
  assembleJasminFile,
  disassembleClassFile,
  decompileClassFile,
  loadClassFileIntoJvm,
  runPath,
  debugPath,
  internalNameOfClassFile,
};
