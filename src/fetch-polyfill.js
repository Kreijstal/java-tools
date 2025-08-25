/**
 * Fetch polyfill that works in both Node.js and browser environments
 */

let fetchImplementation;

if (typeof window !== 'undefined' && window.fetch) {
  // Browser environment - use native fetch
  fetchImplementation = window.fetch.bind(window);
} else if (typeof global !== 'undefined' && global.fetch) {
  // Node.js with global fetch polyfill
  fetchImplementation = global.fetch;
} else {
  // Node.js environment without global fetch - create a minimal implementation
  // This will only work for basic cases and should be replaced with node-fetch for full functionality
  fetchImplementation = (url, options = {}) => {
    // Try to use node-fetch if available, otherwise provide a minimal implementation
    try {
      const nodeFetch = eval('require')('node-fetch');
      return nodeFetch(url, options);
    } catch (e) {
      // Minimal implementation for cases where node-fetch is not available
      return Promise.reject(new Error(`Fetch is not available. To use URL operations in Node.js, install node-fetch: npm install node-fetch`));
    }
  };
}

module.exports = fetchImplementation;