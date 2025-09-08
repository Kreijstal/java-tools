/**
 * Browser entry point for JVM Debug functionality
 * This module exposes the real JVM debug logic for browser use
 */

// Import the real JVM and debug controller classes
const { JVM, Frame } = require('./jvm');
const DebugController = require('./debugController');
const BrowserFileProvider = require('./BrowserFileProvider');
const { setFileProvider } = require('./classLoader');
const awtFramework = require('./awt');
// const { getDisassembled } = require('jvm_parser'); // No longer needed - using krak2 format

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
   * Continue execution
   * @returns {object} - Execution result
   */
  continue() {
    return this.debugController.continue();
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
   * List available files in virtual file system
   * @returns {Promise<Array>} - File list
   */
  async listFiles() {
    return await this.fileProvider.listFiles();
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
      const { convertJson, unparseDataStructures } = require('./convert_tree');
      
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
  JVM,
  Frame,
  DebugController,
  BrowserFileProvider,
  awtFramework
};

// Also make available as global for direct script inclusion
if (typeof window !== 'undefined') {
  window.JVMDebug = {
    BrowserJVMDebug,
    JVM,
    Frame,
    DebugController,
    BrowserFileProvider
  };
  window.awtFramework = awtFramework;
}