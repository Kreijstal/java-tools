// The browser JVM already requires WebAssembly and BigInt. Target browsers
// that provide those features natively so Babel does not lower async functions:
// the runtime discovers AsyncFunction dynamically to compile JIT bodies that
// contain await, and lowering that probe silently disables generated JS code.
module.exports = {
  presets: [
    ['@babel/preset-env', {
      bugfixes: true,
      modules: false,
      targets: {
        chrome: '67',
        edge: '79',
        firefox: '68',
        safari: '14',
      },
    }],
  ],
};
