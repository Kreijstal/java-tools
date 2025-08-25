/**
 * Example of using the isomorphic window pattern
 * 
 * This demonstrates how code can use `require('window')` to access
 * the window object in both browser and Node.js environments.
 * 
 * In the browser (via webpack), this will resolve to the real window object.
 * In Node.js, this will resolve to a mock window object with essential APIs.
 */

// Example of isomorphic window usage (uncomment to test)
// const window = require('window');
// 
// // This would work in both environments:
// const canvas = window.document.createElement('canvas');
// const ctx = canvas.getContext('2d');
// ctx.fillStyle = 'red';
// ctx.fillRect(0, 0, 100, 100);

// For the AWT framework specifically, the isomorphic pattern is already
// built-in through environment detection, so explicit window imports are not needed.
// The AWT classes use CommonJS exports and can be imported normally:

const { Canvas, Frame, AwtMouseEvent } = require('../awt');

console.log('✅ AWT Framework Usage Examples');
console.log('');

// 1. Basic AWT component creation (works in both CLI and browser)
console.log('1. Creating AWT components:');
const frame = new Frame('Example Frame');
const canvas = new Canvas();
frame.add(canvas);

console.log(`   - Created frame: "${frame.title || 'Untitled'}"`);
console.log(`   - Added canvas to frame`);
console.log(`   - Frame has ${frame.components.length} component(s)`);

// 2. Graphics operations (automatically uses correct implementation)
console.log('\n2. Graphics operations:');
const graphics = canvas.getGraphics();
graphics.setColor({ r: 255, g: 100, b: 50 });
graphics.fillRect(10, 10, 80, 60);
graphics.drawString('Hello AWT!', 20, 40);

// In CLI, operations are recorded for testing
if (graphics.getOperations) {
    console.log('   Operations recorded:');
    graphics.getOperations().forEach(op => console.log(`     ${op}`));
} else {
    console.log('   Drawing operations executed on real canvas');
}

// 3. Event handling
console.log('\n3. Event handling:');
let eventCount = 0;

canvas.addMouseListener({
    mousePressed: (event) => {
        eventCount++;
        console.log(`   Mouse pressed at: (${event.getX()}, ${event.getY()})`);
    }
});

// Simulate a mouse event
const mouseEvent = new AwtMouseEvent(canvas, 501, 50, 75, 1, false);
canvas.processMouseEvent(mouseEvent);
console.log(`   Total events processed: ${eventCount}`);

// 4. Environment detection (built-in to AWT)
console.log('\n4. Environment adaptation:');
const imageClass = canvas.createImage(100, 100).constructor.name;
const graphicsClass = graphics.constructor.name;

console.log(`   Image implementation: ${imageClass}`);
console.log(`   Graphics implementation: ${graphicsClass}`);
console.log(`   Environment: ${typeof document === 'undefined' ? 'CLI/Node.js' : 'Browser'}`);

console.log('\n✨ The AWT framework automatically adapts to the runtime environment!');
console.log('   - In browsers: Uses HTML5 Canvas for real rendering');
console.log('   - In CLI/Node.js: Uses mock implementations for testing');
console.log('   - No window namespace pollution - all exports via CommonJS');
console.log('   - Optional isomorphic window pattern available if needed');

module.exports = {
    demonstrateAwtUsage: () => {
        console.log('AWT demonstration completed successfully');
        return { frame, canvas, graphics, eventCount };
    }
};