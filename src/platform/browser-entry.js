/**
 * Browser entry point for JVM Debug functionality
 * This module exposes the real JVM debug logic for browser use
 */

// Import the real JVM and debug controller classes
const { JVM } = require('../core/jvm');
const Frame = require('../core/frame');
const DebugController = require('../debug/debugController');
const BrowserFileProvider = require('../io/BrowserFileProvider');
const { setFileProvider } = require('../core/classLoader');
const awtFramework = require('./awt');
const audioPlatform = require('./audio');
const legacyPlatform = require('./legacy');
const { decompileClassBytes } = require('../decompiler/cfr');
const { compileJavaSource, compileJavaFiles } = require('../java-frontend/compiler');
const { assembleJasminBytes } = require('../utils/jasminAssembly');
const { getDefaultZenFSWorkspace } = require('../io/ZenFSWorkspace');
// const { getDisassembled } = require('jvm_parser'); // No longer needed - using krak2 format

function thrownValueMessage(error) {
  if (error === null) return 'null';
  if (error === undefined) return 'undefined';
  if (typeof error !== 'object') return String(error);
  const type = typeof error.type === 'string' ? error.type : '';
  let message = error.message;
  if (message && typeof message === 'object' &&
      Object.prototype.hasOwnProperty.call(message, 'value')) {
    message = message.value;
  }
  if (message !== undefined && message !== null && String(message)) {
    return type ? `${type}: ${String(message)}` : String(message);
  }
  if (type) return type;
  if (error.name && error.name !== 'Error') return String(error.name);
  if (error.message !== undefined) return String(error.message);
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch (_) {
    // A host Error or Java object may be cyclic. The constructor name is still
    // more useful than silently producing an empty message.
  }
  return error.constructor && error.constructor.name
    ? error.constructor.name
    : String(error);
}

function compileJavaForBrowser(source, options = {}) {
  const result = compileJavaSource(source, options);
  const artifacts = result.classes.map((classEntry) => {
    const bytes = assembleJasminBytes(classEntry.jasmin, options.assembly || {});
    return {
      internalName: classEntry.internalName,
      binaryName: classEntry.binaryName,
      sourceFile: classEntry.sourceFile,
      jasmin: classEntry.jasmin,
      bytes: new Uint8Array(bytes),
    };
  });
  return {
    schema: result.schema,
    version: result.version,
    sourceLevel: result.sourceLevel,
    status: result.bytecodeIr.status,
    artifacts,
  };
}

function compileJavaFilesForBrowser(inputPaths, options = {}) {
  const fileSystem = options.fileSystem || options.fs;
  if (!fileSystem) {
    throw new TypeError('Browser multi-file compilation requires a workspace filesystem');
  }
  const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const result = compileJavaFiles(inputPaths, options);
  const writtenByInternalName = new Map(
    result.written.map((entry) => [entry.internalName, entry]),
  );
  // Reading or assembling every class back out is its own pass over the batch,
  // so it gets its own phase: on a large workspace the compile phase would
  // otherwise report 100% and then appear to stall here.
  const artifactTotal = result.classes.length;
  const artifactStartedAt = Date.now();
  report({ phase: 'artifact', event: 'start', total: artifactTotal, completed: 0 });
  const artifacts = result.classes.map((classEntry, index) => {
    report({
      phase: 'artifact',
      event: 'file-start',
      index,
      total: artifactTotal,
      completed: index,
      internalName: classEntry.internalName,
      inputPath: classEntry.sourceFile,
    });
    const written = writtenByInternalName.get(classEntry.internalName);
    const bytes = written
      ? fileSystem.readFileSync(written.outputPath)
      : assembleJasminBytes(classEntry.jasmin, options.assembly || {});
    report({
      phase: 'artifact',
      event: 'file-end',
      index,
      total: artifactTotal,
      completed: index + 1,
      internalName: classEntry.internalName,
      inputPath: classEntry.sourceFile,
      outputPath: written ? written.outputPath : null,
      byteLength: bytes.length,
    });
    return {
      internalName: classEntry.internalName,
      binaryName: classEntry.binaryName,
      sourceFile: classEntry.sourceFile,
      outputPath: written ? written.outputPath : null,
      jasmin: classEntry.jasmin,
      bytes: new Uint8Array(bytes),
    };
  });
  report({
    phase: 'artifact',
    event: 'end',
    total: artifactTotal,
    completed: artifactTotal,
    durationMs: Date.now() - artifactStartedAt,
  });
  return { ...result, artifacts };
}

const browserJavaTools = {
  assembleJasmin(source, options = {}) {
    return new Uint8Array(assembleJasminBytes(source, options));
  },
  compileJava: compileJavaForBrowser,
  compileJavaFiles: compileJavaFilesForBrowser,
  decompileClass(classData, options = {}) {
    return decompileClassBytes(classData, options);
  },
};

// Browser-compatible JVM Debug API
class BrowserJVMDebug {
  constructor() {
    // Set up browser file provider
    this.fileProvider = new BrowserFileProvider();
    setFileProvider(this.fileProvider);
    
    // Create the real debug controller with rewind history enabled and classpath set to root
    this.debugController = new DebugController({ rewindHistorySize: 50, classpath: ['.'] });
    this.isReady = false;
  }

  /**
   * Initialize the debug environment with data package or uploaded files
   * @param {object} options - Initialization options
   * @returns {Promise<object>} - Initialization result
   */
  async initialize(options = {}) {
    try {
      if (options.workspaceFileSystem) {
        this.fileProvider.attachWorkspace(options.workspaceFileSystem);
      } else if (options.workspace) {
        await this.ensureWorkspace();
      }

      // Load data package if provided
      if (options.dataPackage) {
        await this.fileProvider.loadDataPackage(options.dataPackage);
        /* HARDENED: Removed defensive optional chaining */
        console.log('Loaded data package with', options.dataPackage.classes.length, 'classes');
      }

      // Load from URL if provided
      if (options.dataUrl) {
        const response = await fetch(options.dataUrl);
        const dataPackage = await response.json();
        await this.fileProvider.loadDataPackage(dataPackage);
        /* HARDENED: Removed defensive optional chaining */
        console.log('Loaded data from URL with', dataPackage.classes.length, 'classes');
      }

      this.isReady = true;
      return {
        status: 'initialized',
        filesLoaded: (await this.fileProvider.listFiles()).length
      };
    } catch (error) {
      console.error('Failed to initialize JVM Debug:', error);
      throw new Error(`Initialization failed: ${error.message}`);
    }
  }

  /**
   * Load a file from user upload
   * @param {File} file - File object from file input
   * @returns {Promise<object>} - Load result
   */
  async loadFile(file) {
    try {
      const virtualPath = await this.fileProvider.loadFromFile(file);
      return {
        status: 'loaded',
        virtualPath: virtualPath,
        fileName: file.name,
        size: file.size
      };
    } catch (error) {
      console.error('Failed to load file:', error);
      throw new Error(`File load failed: ${error.message}`);
    }
  }

  /**
   * Return the classes and manifest entry point found in a previously uploaded JAR.
   * @param {string} fileName
   * @returns {{classFiles: string[], resourceFiles: string[], mainClass: string|null}|null}
   */
  getJarInfo(fileName) {
    return this.fileProvider.getJarInfo(fileName);
  }

  /**
   * Start debugging a class
   * @param {string} classPath - Path to the class file (virtual path) or class name
   * @param {object} options - Debug options
   * @returns {Promise<object>} - Debug session start result
   */
  async start(classPath, options = {}) {
    if (!this.isReady) {
      throw new Error('JVM Debug not initialized. Call initialize() first.');
    }

    try {
      // Reset the debug controller to clear any previous session state
      // This ensures thread arrays and other state are properly reset
      this.debugController.reset();
      
      // Strip .class extension if present since DebugController expects class name only
      const className = classPath.endsWith('.class') ? classPath.replace('.class', '') : classPath;
      
      // Use the real debug controller to start debugging
      const result = await this.debugController.start(className, options);
      return result;
    } catch (error) {
      console.error('Failed to start debugging:', error);
      throw new Error(`Debug start failed: ${error.message}`);
    }
  }

  /**
   * Run a class without debugging (execute to completion).
   * @param {string} classPath - Path to the class file (virtual path) or class name
   * @param {object} options - Run options
   * @returns {Promise<object>} - Run result
   */
  async run(classPath, options = {}) {
    if (!this.isReady) {
      throw new Error('JVM Debug not initialized. Call initialize() first.');
    }

    try {
      this.debugController.reset();
      const className = classPath.endsWith('.class')
        ? classPath.replace('.class', '')
        : classPath;

      this.debugController.executionState = 'running';
      await this.debugController.jvm.run(className, options);
      this.debugController.executionState = 'stopped';
      return { status: 'completed' };
    } catch (error) {
      this.debugController.executionState = 'stopped';
      console.error('Failed to run class:', error);
      const wrapped = new Error(`Run failed: ${thrownValueMessage(error)}`);
      wrapped.cause = error;
      if (error && typeof error.stack === 'string') {
        wrapped.causeStack = error.stack;
      }
      if (error && error.jvmGuestLocation) {
        wrapped.jvmGuestLocation = error.jvmGuestLocation;
      }
      if (error && typeof error.type === 'string') {
        wrapped.jvmExceptionType = error.type;
        wrapped.jvmExceptionMessage = thrownValueMessage(error);
      }
      throw wrapped;
    }
  }

  /**
   * Continue execution
   * @returns {object} - Execution result
   */
  continue() {
    return this.debugController.continue();
  }

  /**
   * Pause execution
   * @returns {object} - Pause result
   */
  pause() {
    return this.debugController.pause();
  }

  /**
   * Step into next instruction
   * @returns {object} - Step result
   */
  stepInto() {
    return this.debugController.stepInto();
  }

  /**
   * Step over next instruction
   * @returns {object} - Step result
   */
  stepOver() {
    return this.debugController.stepOver();
  }

  /**
   * Step out of current method
   * @returns {object} - Step result
   */
  stepOut() {
    return this.debugController.stepOut();
  }

  /**
   * Execute single instruction
   * @returns {object} - Step result
   */
  stepInstruction() {
    return this.debugController.stepInstruction();
  }

  /**
   * Rewind execution by one or more steps
   * @param {number} steps - Number of steps to rewind (default: 1)
   * @returns {object} - Rewind result
   */
  rewind(steps = 1) {
    return this.debugController.rewind(steps);
  }

  /**
   * Set a breakpoint
   * @param {number} pc - Program counter location
   * @returns {object} - Breakpoint result
   */
  setBreakpoint(pc) {
    return this.debugController.setBreakpoint(pc);
  }

  /**
   * Remove a breakpoint
   * @param {number} pc - Program counter location
   * @returns {object} - Breakpoint result
   */
  removeBreakpoint(pc) {
    return this.debugController.removeBreakpoint(pc);
  }

  /**
   * Clear all breakpoints
   * @returns {object} - Clear result
   */
  clearBreakpoints() {
    return this.debugController.clearBreakpoints();
  }

  /**
   * Get list of breakpoints
   * @returns {Array} - List of breakpoint PC locations
   */
  getBreakpoints() {
    return this.debugController.getBreakpoints();
  }

  /**
   * Get current execution state
   * @returns {object} - Current state
   */
  getCurrentState() {
    return this.debugController.getCurrentState();
  }

  /**
   * Serialize JVM state
   * @returns {object} - Serialized state
   */
  serialize() {
    return this.debugController.serialize();
  }

  /**
   * Deserialize JVM state
   * @param {object} state - Serialized state
   * @returns {object} - Restore result
   */
  deserialize(state) {
    return this.debugController.deserialize(state);
  }

  saveState() {
    return this.debugController.jvm.saveState();
  }

  loadState(state) {
    return this.debugController.jvm.loadState(state);
  }

  /**
   * Reset debug session
   * @returns {object} - Reset result
   */
  reset() {
    return this.debugController.reset();
  }

  /**
   * Get disassembly view
   * @returns {object} - Disassembly information
   */
  getDisassemblyView() {
    return this.debugController.getDisassemblyView();
  }

  getThreads() {
    return this.debugController.getThreads();
  }

  selectThread(threadId) {
    return this.debugController.selectThread(threadId);
  }

  /**
   * Get backtrace
   * @returns {Array} - Call stack frames
   */
  getBacktrace() {
    return this.debugController.getBacktrace();
  }

  /**
   * Inspect stack
   * @returns {Array} - Stack values
   */
  inspectStack() {
    return this.debugController.inspectStack();
  }

  /**
   * Inspect local variables
   * @returns {Array} - Local variables
   */
  inspectLocals() {
    return this.debugController.inspectLocals();
  }

  /**
   * Compile and run a Java snippet against the live heap.
   * Requires debug mode; the snippet is guest code with full side effects.
   * @param {string} source - a Java expression or block of statements
   * @param {object} options - { stepBudget, sourceLevel }
   * @returns {Promise<object>} - Evaluated value and generated class names
   */
  async evaluate(source, options = {}) {
    return this.debugController.evaluate(source, options);
  }

  /**
   * Get available variable names for locals
   * @returns {Array} - Local variable names
   */
  getAvailableVariableNames() {
    return this.debugController.getAvailableVariableNames();
  }

  /**
   * List available files in virtual file system
   * @returns {Promise<Array>} - File list
   */
  async listFiles() {
    return await this.fileProvider.listFiles();
  }

  /**
   * Lazily enable the editor workspace without adding ZenFS to ordinary JVM
   * startup. Existing uploaded classes and resources are migrated intact.
   * @returns {Promise<WorkspaceFileSystem>}
   */
  async ensureWorkspace() {
    let workspace = this.fileProvider.getWorkspaceFileSystem();
    if (!workspace) {
      workspace = await getDefaultZenFSWorkspace();
      this.fileProvider.attachWorkspace(workspace);
    }
    return workspace;
  }

  /**
   * Write an editor or generated file into the shared browser workspace.
   * @param {string} filePath
   * @param {string|Uint8Array} content
   */
  writeWorkspaceFile(filePath, content) {
    const workspace = this.fileProvider.getWorkspaceFileSystem();
    if (!workspace) throw new Error('Browser workspace is not initialized');
    workspace.map.set(filePath, content);
  }

  /**
   * Read a file from the shared browser workspace.
   * @param {string} filePath
   * @param {string|null} encoding
   */
  readWorkspaceFile(filePath, encoding = null) {
    const workspace = this.fileProvider.getWorkspaceFileSystem();
    if (!workspace) throw new Error('Browser workspace is not initialized');
    return workspace.readFileSync(filePath, encoding || undefined);
  }

  /**
   * Compile Java source files from the browser workspace and emit class files
   * back into the same workspace.
   * @param {string[]} inputPaths
   * @param {object} options - compile options. Pass `onProgress(event)` to
   *   follow a large batch file by file; events are
   *   `{ phase: 'scan'|'compile'|'artifact', event: 'start'|'file-start'|'file-end'|'file-error'|'end', total, completed, index?, inputPath? }`.
   *   The hook runs synchronously between files, so a browser caller that wants
   *   the DOM to repaint must compile in slices (or a worker) rather than
   *   expecting this call to yield.
   */
  compileWorkspace(inputPaths, options = {}) {
    const workspace = this.fileProvider.getWorkspaceFileSystem();
    if (!workspace) throw new Error('Browser workspace is not initialized');
    return compileJavaFilesForBrowser(inputPaths, {
      ...options,
      fileSystem: workspace,
      sourceRoot: options.sourceRoot || '/src',
      outputDir: options.outputDir || '/classes',
    });
  }

  /**
   * Get file provider for advanced operations
   * @returns {BrowserFileProvider} - File provider instance
   */
  getFileProvider() {
    return this.fileProvider;
  }


  /**
   * Get disassembly of a class without starting debug session
   * @param {Uint8Array} classData - The binary class file data
   * @returns {string} - The disassembled bytecode
   */
  getClassDisassembly(classData) {
    try {
      // Use the same krak2 format as debugging for consistency
      const { getAST } = require('jvm_parser');
      const { convertJson, unparseDataStructures } = require('../parsing/convert_tree');
      
      // Parse class data to AST
      const ast = getAST(classData);
      
      // Convert AST to structured format
      const convertedAst = convertJson(ast.ast, ast.constantPool);
      
      // Check if conversion was successful and classes exist
      /* HARDENED: Replaced quiet failure with an explicit error */
      if (!convertedAst || !convertedAst.classes || !convertedAst.classes[0]) {
        throw new Error('Unable to parse class structure. The class file may be corrupted or use unsupported features.');
      }
      
      // Ensure constantPool exists for unparseDataStructures
      /* HARDENED: Removed defensive default */
      const constantPool = ast.constantPool;
      
      // Generate krak2 format disassembly
      const disassembly = unparseDataStructures(convertedAst.classes[0], constantPool);
      
      return disassembly;
    } catch (error) {
      /* HARDENED: Replaced quiet failure with an explicit error */
      throw new Error(`Error disassembling class: ${error.message}`, { cause: error });
    }
  }

  /**
   * Get method metadata for a class file in the virtual file system.
   * @param {string} classPath - Virtual file path or class name
   * @returns {Promise<Array>} - Array of method metadata
   */
  async getClassMethods(classPath) {
    const normalizedPath = classPath.endsWith(".class")
      ? classPath
      : `${classPath}.class`;
    const classData = await this.fileProvider.readFile(normalizedPath);
    const { getAST } = require("jvm_parser");
    const { convertJson } = require("../parsing/convert_tree");

    const ast = getAST(classData);
    const converted = convertJson(ast.ast, ast.constantPool);
    const items =
      (converted.classes && converted.classes[0] && converted.classes[0].items) ||
      [];

    return items
      .filter((item) => item.type === "method")
      .map((item) => ({
        name: item.method.name,
        descriptor: item.method.descriptor,
        accessFlags: item.method.accessFlags || 0,
      }));
  }

  /**
   * Describe whether a class can be launched by this JVM as an application or
   * applet. Superclasses are resolved from the browser virtual classpath.
   * @param {string} classPath
   * @returns {Promise<{className: string, launchMode: "application"|"applet"|null}>}
   */
  async getClassLaunchInfo(classPath) {
    const normalizedPath = classPath.endsWith(".class")
      ? classPath
      : `${classPath}.class`;
    const { getAST } = require("jvm_parser");
    const { convertJson } = require("../parsing/convert_tree");
    const parseClass = (classData) => {
      const parsed = getAST(classData);
      return convertJson(parsed.ast, parsed.constantPool).classes[0];
    };

    const rootClass = parseClass(await this.fileProvider.readFile(normalizedPath));
    const hasMain = (rootClass.items || []).some((item) =>
      item.type === "method" &&
      item.method.name === "main" &&
      item.method.descriptor === "([Ljava/lang/String;)V" &&
      (item.method.accessFlags & 0x0009) === 0x0009);
    let current = rootClass;
    const visited = new Set();
    while (current && !visited.has(current.className)) {
      visited.add(current.className);
      const superName = current.superClassName;
      if (superName === "java/applet/Applet") {
        return { className: rootClass.className, launchMode: "applet" };
      }
      if (!superName || superName === "java/lang/Object") break;
      const superPath = `${superName}.class`;
      if (!await this.fileProvider.exists(superPath)) break;
      current = parseClass(await this.fileProvider.readFile(superPath));
    }
    return {
      className: rootClass.className,
      launchMode: hasMain ? "application" : null,
    };
  }

  /**
   * Check if debugger is ready
   * @returns {boolean} - Ready status
   */
  isInitialized() {
    return this.isReady;
  }
}

// Export for browser use
module.exports = {
  BrowserJVMDebug,
  thrownValueMessage,
  JVM,
  Frame,
  DebugController,
  BrowserFileProvider,
  browserJavaTools,
  javaTools: browserJavaTools,
  awtFramework,
  audioPlatform,
  legacyPlatform
};

// Also make available as global for direct script inclusion
if (typeof window !== 'undefined') {
  window.JVMDebug = {
    BrowserJVMDebug,
    JVM,
    Frame,
    DebugController,
    BrowserFileProvider,
    javaTools: browserJavaTools,
    audioPlatform,
    legacyPlatform
  };
  window.awtFramework = awtFramework;
  // Register the browser javax.sound backend as part of the runtime bundle.
  // Some embedders load only jvm-debug.js (without the full debug-site HTML);
  // leaving registration to a second script silently selected MockAudioOutput.
  require('./web-audio');
}
