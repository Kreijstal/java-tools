/**
 * Simple static file server for serving the debug interface for Playwright tests
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, '..');

// MIME types for common file extensions
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'text/plain';
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }

    const mimeType = getMimeType(filePath);
    res.writeHead(200, { 
      'Content-Type': mimeType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(data);
  });
}

// Function to ensure build dependencies are met
function ensureBuildDependencies() {
  const distDir = path.join(PUBLIC_DIR, 'dist');
  const indexPath = path.join(distDir, 'index.html');
  
  // Check if dist/index.html exists
  if (!fs.existsSync(indexPath)) {
    console.log('📦 Build artifacts not found. Running build process...');
    try {
      execSync('npm run build', { 
        cwd: PUBLIC_DIR, 
        stdio: 'inherit' 
      });
      console.log('✅ Build completed successfully');
    } catch (error) {
      console.error('❌ Build failed:', error.message);
      process.exit(1);
    }
  }
}

const server = http.createServer((req, res) => {
  let urlPath = req.url;
  
  // Remove query parameters
  urlPath = urlPath.split('?')[0];
  
  // Security: prevent directory traversal
  const normalizedPath = path.normalize(urlPath);
  if (normalizedPath.includes('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let filePath;
  if (normalizedPath.startsWith('/examples/')) {
    // Serve examples from the root directory for development access
    filePath = path.join(PUBLIC_DIR, normalizedPath);
  } else if (normalizedPath.startsWith('/dist/')) {
    // Legacy compatibility: serve /dist/* requests from dist directory 
    // This removes /dist/ prefix and serves from actual dist directory
    const distRelativePath = normalizedPath.substring(5); // Remove '/dist'
    if (distRelativePath === '' || distRelativePath === '/') {
      filePath = path.join(PUBLIC_DIR, 'dist', 'index.html');
    } else {
      filePath = path.join(PUBLIC_DIR, 'dist', distRelativePath);
    }
  } else {
    // Serve everything else from dist directory to match GitHub Pages exactly
    if (normalizedPath === '/') {
      filePath = path.join(PUBLIC_DIR, 'dist', 'index.html');
    } else {
      filePath = path.join(PUBLIC_DIR, 'dist', normalizedPath);
    }
  }
  
  fs.stat(filePath, (err, stats) => {
    if (err) {
      // Log the error for debugging
      console.log(`[ERROR] File not found: ${filePath} (requested: ${normalizedPath})`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }

    if (stats.isFile()) {
      serveFile(res, filePath);
    } else if (stats.isDirectory()) {
      // Try to serve index.html from the directory
      const indexPath = path.join(filePath, 'index.html');
      fs.stat(indexPath, (indexErr, indexStats) => {
        if (indexErr || !indexStats.isFile()) {
          console.log(`[ERROR] Directory index not found: ${indexPath} (requested: ${normalizedPath})`);
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('File not found');
          return;
        }
        serveFile(res, indexPath);
      });
    } else {
      console.log(`[ERROR] Not a file or directory: ${filePath} (requested: ${normalizedPath})`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    }
  });
});

// Ensure build dependencies before starting server
ensureBuildDependencies();

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Debug interface available at http://localhost:${PORT}/ (built version with sample classes)`);
  console.log(`Raw template available at http://localhost:${PORT}/examples/debug-web-interface.html (no sample classes)`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});