const path = require('path');
const browserBabel = require('./config/browser-babel');

const jvmDebugConfig = {
  mode: 'production',
  entry: './src/platform/browser-entry.js',
  output: {
    filename: 'jvm-debug.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'JVMDebug',
    libraryTarget: 'umd',
    globalObject: 'this'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: browserBabel
        }
      }
    ]
  },
  resolve: {
    alias: {
      // Isomorphic window module - use browser implementation for webpack builds
      'window': path.resolve(__dirname, 'src/isomorphic/window.browser.js'),
      'os': path.resolve(__dirname, 'src/isomorphic/os.browser.js'),
      'net': path.resolve(__dirname, 'src/isomorphic/net.browser.js'),
      'dns': path.resolve(__dirname, 'src/isomorphic/dns.browser.js'),
      'zlib': path.resolve(__dirname, 'src/isomorphic/zlib.browser.js')
    },
    fallback: {
      // Provide browser-compatible alternatives for Node.js modules
      "fs": false,
      "path": require.resolve("path-browserify"),
      "util": require.resolve("util/"),
      "stream": require.resolve("stream-browserify"),
      "buffer": require.resolve("buffer/"),
      "process": require.resolve("process/browser"),
      "v8": false, // Make v8 return false instead of trying to load it
      "crypto": false,
      "url": require.resolve("url/"),
      // Handle node-fetch v3 and Node.js native modules
      "node-fetch": false, // Use browser fetch instead
      "node:util": require.resolve("util/"),
      "node:zlib": false,
      "node:stream": require.resolve("stream-browserify"),
      "node:http": false,
      "node:https": false,
      "node:url": require.resolve("url/"),
      "node:fs": false,
      "node:path": require.resolve("path-browserify"),
      "node:buffer": require.resolve("buffer/"),
      "node:process": require.resolve("process/browser"),
      "speaker": false,
      // Additional node-fetch dependencies
      "fetch-blob": false,
      "formdata-polyfill": false,
      "web-streams-polyfill": false,
    }
  },
  plugins: [
    new (require('webpack')).ProvidePlugin({
      process: 'process/browser',
      Buffer: ['buffer', 'Buffer'],
    }),
  ],
  externals: {
    // Remove externals since we want everything bundled for browser use
    // The fallbacks above will handle Node.js modules
  },
  devtool: 'source-map'
};

// The IDE shell is a plain page-controller bundle: it drives the globals the
// jvm-debug bundle installs (window.JVMDebug, window.jvmDebug, window.ace,
// window.Terminal) and only bundles golden-layout, so it must not claim a
// UMD library global of its own.
const ideUiConfig = {
  mode: 'production',
  entry: './src/platform/ide/main.js',
  output: {
    filename: 'ide-ui.js',
    path: path.resolve(__dirname, 'dist')
  },
  module: jvmDebugConfig.module,
  devtool: 'source-map'
};

module.exports = [jvmDebugConfig, ideUiConfig];
