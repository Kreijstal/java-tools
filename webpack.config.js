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