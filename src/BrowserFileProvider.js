const FileProvider = require('./FileProvider');

/**
 * Browser implementation of FileProvider with support for file uploads and virtual file system
 * Supports loading files from URLs, file uploads, and JAR archives
 */
class BrowserFileProvider extends FileProvider {
  constructor() {
    super();
    // Virtual file system to store loaded files
    this.virtualFS = new Map(); // Map<string, Uint8Array>
    this.loadedJars = new Set(); // Track loaded JAR files
  }

  /**
   * Check if a file exists in the virtual file system
   * @param {string} filePath - Path to the file
   * @returns {Promise<boolean>} - True if file exists
   */
  async exists(filePath) {
    return this.virtualFS.has(filePath);
  }

  /**
   * Read file content from virtual file system
   * @param {string} filePath - Path to the file
   * @returns {Promise<Uint8Array>} - File content as bytes
   */
  async readFile(filePath) {
    const content = this.virtualFS.get(filePath);
    if (!content) {
      throw new Error(`File not found: ${filePath}`);
    }
    return content;
  }

  /**
   * Load a file from a URL into the virtual file system
   * @param {string} url - URL to load file from
   * @param {string} virtualPath - Virtual path to store the file at
   * @returns {Promise<void>}
   */
  async loadFromUrl(url, virtualPath) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        /* HARDENED: More specific error */
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const content = new Uint8Array(arrayBuffer);
      this.virtualFS.set(virtualPath, content);
    } catch (error) {
      throw new Error(`Failed to load file from URL ${url}: ${error.message}`);
    }
  }

  /**
   * Load files from a File object (from file input)
   * @param {File} file - File object from file input
   * @param {string} virtualPath - Virtual path to store the file at (optional)
   * @returns {Promise<string>} - Virtual path where file was stored
   */
  async loadFromFile(file, virtualPath = null) {
    if (!virtualPath) {
      virtualPath = file.name;
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const arrayBuffer = event.target.result;
        const content = new Uint8Array(arrayBuffer);
        
        // Check if it's a JAR file (ZIP archive)
        if (file.name.endsWith('.jar') || file.name.endsWith('.zip')) {
          this.loadJarArchive(content, file.name)
            .then(() => resolve(virtualPath))
            .catch(reject);
        } else {
          this.virtualFS.set(virtualPath, content);
          resolve(virtualPath);
        }
      };
      reader.onerror = (event) => reject(new Error(`Failed to read file ${file.name}: ${event.target.error}`));
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Load a JAR archive and extract all .class files to virtual file system
   * @param {Uint8Array} jarContent - JAR file content
   * @param {string} jarName - Name of the JAR file
   * @returns {Promise<string[]>} - Array of extracted file paths
   */
  async loadJarArchive(jarContent, jarName) {
    // Dynamic import of JSZip for browser compatibility
    const JSZip = await this.getJSZip();
    
    try {
      const zip = new JSZip();
      await zip.loadAsync(jarContent);
      
      const extractedFiles = [];
      
      // Extract all .class files
      for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
        if (!zipEntry.dir && relativePath.endsWith('.class')) {
          const content = await zipEntry.async('uint8array');
          this.virtualFS.set(relativePath, content);
          extractedFiles.push(relativePath);
        }
      }
      
      this.loadedJars.add(jarName);
      return extractedFiles;
    } catch (error) {
      throw new Error(`Failed to extract JAR ${jarName}: ${error.message}`);
    }
  }

  /**
   * Load multiple files from data package (for pre-compiled class files)
   * @param {object} dataPackage - Object containing file data
   * @returns {Promise<void>}
   */
  async loadDataPackage(dataPackage) {
    if (dataPackage.classes) {
      for (const classInfo of dataPackage.classes) {
        if (classInfo.filename && classInfo.content) {
          // Decode base64 content if needed
          let content;
          if (typeof classInfo.content === 'string') {
            // Assume base64 encoded
            const binaryString = atob(classInfo.content);
            content = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              content[i] = binaryString.charCodeAt(i);
            }
          } else {
            content = new Uint8Array(classInfo.content);
          }
          
          this.virtualFS.set(classInfo.filename, content);
        }
      }
    }
  }

  /**
   * List files in the virtual file system
   * @param {string} dirPath - Directory path to list (optional)
   * @returns {Promise<string[]>} - Array of file names
   */
  async listFiles(dirPath = '') {
    const files = [];
    for (const path of this.virtualFS.keys()) {
      /* HARDENED: Removed defensive check */
      if (path.startsWith(dirPath)) {
        files.push(path);
      }
    }
    return files;
  }

  /**
   * Clear the virtual file system
   */
  clear() {
    this.virtualFS.clear();
    this.loadedJars.clear();
  }

  /**
   * Get list of loaded JAR files
   * @returns {string[]} - Array of JAR file names
   */
  getLoadedJars() {
    return Array.from(this.loadedJars);
  }

  /**
   * Get file size in virtual file system
   * @param {string} filePath - Path to file
   * @returns {number} - File size in bytes, or -1 if not found
   */
  getFileSize(filePath) {
    const content = this.virtualFS.get(filePath);
    /* HARDENED: Replaced quiet failure with an explicit error */
    if (content === undefined) {
      throw new Error(`File not found: ${filePath}`);
    }
    return content.length;
  }

  /**
   * Dynamically load JSZip for browser environments
   * @returns {Promise<JSZip>} - JSZip module
   */
  async getJSZip() {
    if (typeof window !== 'undefined' && window.JSZip) {
      return window.JSZip;
    }
    
    // Try to import JSZip
    try {
      const JSZip = (await import('jszip')).default;
      return JSZip;
    } catch (error) {
      throw new Error('JSZip is required for JAR file support. Please include JSZip in your project.');
    }
  }

  /**
   * Join path components (browser-style with forward slashes)
   * @param {...string} components - Path components
   * @returns {string} - Joined path
   */
  joinPath(...components) {
    return components.join('/').replace(/\/+/g, '/');
  }

  /**
   * Convert Windows-style paths to Unix-style for virtual file system
   * @param {string} path - Path to normalize
   * @returns {string} - Normalized path
   */
  normalizePath(path) {
    return path.replace(/\\/g, '/');
  }
}

module.exports = BrowserFileProvider;