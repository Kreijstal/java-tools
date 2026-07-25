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
    this.jarInfo = new Map(); // Map<string, { classFiles: string[], mainClass: string|null }>
  }

  /**
   * Check if a file exists in the virtual file system
   * @param {string} filePath - Path to the file
   * @returns {Promise<boolean>} - True if file exists
   */
  async exists(filePath) {
    const normalized = this.normalizePath(filePath);
    if (this.virtualFS.has(normalized)) {
      return true;
    }
    if (normalized.startsWith('./')) {
      return this.virtualFS.has(normalized.slice(2));
    }
    if (normalized.startsWith('/')) {
      return this.virtualFS.has(normalized.slice(1));
    }
    return false;
  }

  /**
   * Read file content from virtual file system
   * @param {string} filePath - Path to the file
   * @returns {Promise<Uint8Array>} - File content as bytes
   */
  async readFile(filePath) {
    const normalized = this.normalizePath(filePath);
    let content = this.virtualFS.get(normalized);
    if (!content && normalized.startsWith('./')) {
      content = this.virtualFS.get(normalized.slice(2));
    }
    if (!content && normalized.startsWith('/')) {
      content = this.virtualFS.get(normalized.slice(1));
    }
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
        if (/\.(jar|zip)$/i.test(file.name)) {
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
      let manifestText = null;
      
      // Extract all .class files
      for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
        const normalizedPath = this.normalizeArchivePath(relativePath);
        if (!normalizedPath || zipEntry.dir) {
          continue;
        }

        if (normalizedPath.toUpperCase() === 'META-INF/MANIFEST.MF') {
          manifestText = await zipEntry.async('text');
        } else if (/\.class$/i.test(normalizedPath)) {
          const content = await zipEntry.async('uint8array');
          this.virtualFS.set(normalizedPath, content);
          extractedFiles.push(normalizedPath);
        }
      }
      
      this.loadedJars.add(jarName);
      this.jarInfo.set(jarName, {
        classFiles: extractedFiles.sort(),
        mainClass: this.getManifestMainClass(manifestText),
      });
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
    this.jarInfo.clear();
  }

  /**
   * Get list of loaded JAR files
   * @returns {string[]} - Array of JAR file names
   */
  getLoadedJars() {
    return Array.from(this.loadedJars);
  }

  /**
   * Return classes and the manifest entry point discovered for a loaded JAR.
   * @param {string} jarName - Original uploaded file name
   * @returns {{classFiles: string[], mainClass: string|null}|null}
   */
  getJarInfo(jarName) {
    const info = this.jarInfo.get(jarName);
    if (!info) {
      return null;
    }
    return { classFiles: [...info.classFiles], mainClass: info.mainClass };
  }

  /**
   * Reject archive paths that could escape the virtual filesystem root.
   * @param {string} archivePath
   * @returns {string|null}
   */
  normalizeArchivePath(archivePath) {
    const normalized = this.normalizePath(archivePath).replace(/^\/+/, '');
    if (!normalized || normalized.split('/').some((part) => part === '..')) {
      return null;
    }
    return normalized;
  }

  /**
   * Parse the Main-Class attribute, including manifest continuation lines.
   * @param {string|null} manifestText
   * @returns {string|null}
   */
  getManifestMainClass(manifestText) {
    if (!manifestText) {
      return null;
    }

    const unfolded = manifestText.replace(/\r?\n /g, '');
    const match = unfolded.match(/^Main-Class:\s*(.+)\s*$/im);
    return match ? match[1].trim().replace(/\//g, '.') : null;
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
