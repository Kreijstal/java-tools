/**
 * Abstract FileProvider interface for platform-agnostic file operations
 * This allows the JVM core logic to work in both Node.js and browser environments
 */

class FileProvider {
  /**
   * Check if a file exists at the given path
   * @param {string} filePath - Path to the file
   * @returns {Promise<boolean>} - True if file exists
   */
  async exists(filePath) {
    throw new Error('FileProvider.exists() must be implemented');
  }

  /**
   * Read file content as Uint8Array
   * @param {string} filePath - Path to the file
   * @returns {Promise<Uint8Array>} - File content as bytes
   */
  async readFile(filePath) {
    throw new Error('FileProvider.readFile() must be implemented');
  }

  /**
   * List files in a directory (optional for some implementations)
   * @param {string} dirPath - Path to directory
   * @returns {Promise<string[]>} - Array of file names
   */
  async listFiles(dirPath) {
    throw new Error('FileProvider.listFiles() not implemented in this provider');
  }

  /**
   * Get the platform-specific path separator
   * @returns {string} - Path separator
   */
  getPathSeparator() {
    return '/';
  }

  /**
   * Join path components
   * @param {...string} components - Path components
   * @returns {string} - Joined path
   */
  joinPath(...components) {
    return components.join(this.getPathSeparator());
  }
}

module.exports = FileProvider;