const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const FileProvider = require('./FileProvider');

/**
 * Node.js implementation of FileProvider using the fs module
 */
class NodeFileProvider extends FileProvider {
  /**
   * Check if a file exists at the given path
   * @param {string} filePath - Path to the file
   * @returns {Promise<boolean>} - True if file exists
   */
  async exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if a file exists synchronously (for backwards compatibility)
   * @param {string} filePath - Path to the file
   * @returns {boolean} - True if file exists
   */
  existsSync(filePath) {
    return fsSync.existsSync(filePath);
  }

  /**
   * Read file content as Uint8Array
   * @param {string} filePath - Path to the file
   * @returns {Promise<Uint8Array>} - File content as bytes
   */
  async readFile(filePath) {
    const buffer = await fs.readFile(filePath);
    return new Uint8Array(buffer);
  }

  /**
   * Read file content synchronously (for backwards compatibility)
   * @param {string} filePath - Path to the file
   * @returns {Uint8Array} - File content as bytes
   */
  readFileSync(filePath) {
    const buffer = fsSync.readFileSync(filePath);
    return new Uint8Array(buffer);
  }

  /**
   * List files in a directory
   * @param {string} dirPath - Path to directory
   * @returns {Promise<string[]>} - Array of file names
   */
  async listFiles(dirPath) {
    const files = await fs.readdir(dirPath);
    return files;
  }

  /**
   * Get the platform-specific path separator
   * @returns {string} - Path separator
   */
  getPathSeparator() {
    return path.sep;
  }

  /**
   * Join path components using Node.js path module
   * @param {...string} components - Path components
   * @returns {string} - Joined path
   */
  joinPath(...components) {
    return path.join(...components);
  }

  /**
   * Resolve relative path to absolute
   * @param {...string} components - Path components
   * @returns {string} - Resolved path
   */
  resolvePath(...components) {
    return path.resolve(...components);
  }

  /**
   * Get directory name from file path
   * @param {string} filePath - File path
   * @returns {string} - Directory name
   */
  dirname(filePath) {
    return path.dirname(filePath);
  }

  /**
   * Get base name from file path
   * @param {string} filePath - File path
   * @returns {string} - Base name
   */
  basename(filePath) {
    return path.basename(filePath);
  }
}

module.exports = NodeFileProvider;