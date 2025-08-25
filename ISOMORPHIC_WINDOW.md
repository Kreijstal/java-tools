# Isomorphic Window Pattern for AWT

The AWT framework has been updated to eliminate window namespace pollution and provide an optional isomorphic window pattern for cross-platform JavaScript development.

## Changes Made

### 1. Removed Window Namespace Pollution

The AWT framework no longer assigns classes to the global `window` object. All exports are now exclusively through CommonJS:

```javascript
// Before (polluted window namespace):
window.Canvas = Canvas;
window.Frame = Frame;
// ... other classes

// After (clean CommonJS exports only):
module.exports = {
    Canvas,
    Frame,
    // ... other classes
};
```

### 2. Isomorphic Window Pattern

Added support for the isomorphic window pattern that allows code to `require('window')` with different implementations for different environments:

#### Files Created:
- `src/isomorphic/window.browser.js` - Browser window implementation
- `src/isomorphic/window.node.js` - Node.js mock window implementation 
- `webpack.config.js` - Updated with module alias for window resolution

#### Usage Example:

```javascript
// This works in both environments:
const window = require('window');

// Browser: gets real window object
// Node.js: gets mock window with essential APIs
const canvas = window.document.createElement('canvas');
const ctx = canvas.getContext('2d');
```

### 3. Environment Detection Still Works

The AWT framework continues to use environment detection for automatic adaptation:

```javascript
// This pattern is still used and recommended:
if (typeof document !== 'undefined') {
    // Browser-specific code
} else {
    // CLI/Node.js-specific code
}
```

## Benefits

1. **No Window Pollution**: Global namespace stays clean
2. **Modular Design**: All classes imported via CommonJS
3. **Isomorphic Support**: Optional window module pattern available
4. **Backward Compatible**: Existing AWT code continues to work
5. **Test-Friendly**: CLI testing remains fully functional

## Usage

### Standard AWT Usage (Recommended):
```javascript
const { Canvas, Frame } = require('./src/awt');
const frame = new Frame('My App');
const canvas = new Canvas();
frame.add(canvas);
```

### Isomorphic Window Usage (If Needed):
```javascript
const window = require('window'); // Resolves correctly in both environments
const { Canvas } = require('./src/awt');
// Use both window APIs and AWT together
```

The AWT framework automatically detects the runtime environment and uses appropriate implementations without requiring explicit window access in most cases.