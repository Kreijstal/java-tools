const path = require('path');
const browserBabel = require('./config/browser-babel');
const browserBuild = require('./config/browser-build.json');
const browserFallbacks = Object.fromEntries([
  ...Object.entries(browserBuild.polyfills).map(([name, target]) => [name, require.resolve(target)]),
  ...browserBuild.emptyModules.map(name => [name, false]),
]);
for (const [name, target] of Object.entries({...browserFallbacks})) browserFallbacks['node:' + name] = target;

// Cache each compiler separately across invocations. Webpack invalidates
// changed modules and their dependents; config/loader changes invalidate the
// cache too. This affects build work, never generated runtime behavior.
const buildCache = name => ({
  type: 'filesystem',
  name,
  buildDependencies: {
    config: [__filename, require.resolve('./config/browser-babel'),
      require.resolve('./config/growing-buffer-loader')]
  }
});

const jvmDebugConfig = {
  cache: buildCache('jvm-debug'),
  mode: 'production',
  entry: './' + browserBuild.entryPoints['jvm-debug'],
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
        test: /[\\/]utilium[\\/]dist[\\/]buffer\.js$/,
        use: path.resolve(__dirname, 'config/growing-buffer-loader.js')
      },
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
    alias: Object.fromEntries(Object.entries(browserBuild.aliases).map(([name, target]) => [name, path.resolve(__dirname, target)])),
    fallback: browserFallbacks,
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
  cache: buildCache('ide-ui'),
  mode: 'production',
  entry: './src/platform/ide/main.js',
  output: {
    filename: 'ide-ui.js',
    path: path.resolve(__dirname, 'dist')
  },
  module: jvmDebugConfig.module,
  devtool: 'source-map'
};

// The compile worker of Phase 1, as a browser Worker script. It is a separate
// bundle because a Worker is loaded from its own URL: it cannot share the page
// bundle, and the page must be told where this one lands
// (window.JVM_COMPILE_WORKER_URL, or the compileWorkerUrl jit option).
const compileWorkerConfig = {
  cache: buildCache('jvm-compile-worker'),
  mode: 'production',
  target: 'webworker',
  entry: './' + browserBuild.entryPoints['jvm-compile-worker'],
  output: {
    filename: 'jvm-compile-worker.js',
    path: path.resolve(__dirname, 'dist')
  },
  module: jvmDebugConfig.module,
  resolve: jvmDebugConfig.resolve,
  plugins: jvmDebugConfig.plugins,
  devtool: 'source-map'
};

module.exports = [jvmDebugConfig, ideUiConfig, compileWorkerConfig];
