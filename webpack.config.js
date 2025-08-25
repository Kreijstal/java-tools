const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/browser-entry.js',
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
          options: {
            presets: ['@babel/preset-env']
          }
        }
      }
    ]
  },
  resolve: {
    alias: {
      // Isomorphic window module - use browser implementation for webpack builds
      'window': path.resolve(__dirname, 'src/isomorphic/window.browser.js')
    },
    fallback: {
      // Provide browser-compatible alternatives for Node.js modules
      "fs": false,
      "path": require.resolve("path-browserify"),
      "util": require.resolve("util/"),
      "stream": require.resolve("stream-browserify"),
      "buffer": require.resolve("buffer/"),
      "process": require.resolve("process/browser"),
      "os": false, // Make os return false instead of trying to load it
      "v8": false, // Make v8 return false instead of trying to load it
      "crypto": false,
      "zlib": false,
      "dns": false,
      "net": false,
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