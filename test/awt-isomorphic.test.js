const test = require('tape');

// Test the isomorphic window pattern
test('Isomorphic window pattern - Node.js environment', (t) => {
    // This test verifies that we can use the window module pattern in Node.js
    const windowModule = require('../src/isomorphic/window.node.js');
    
    t.ok(windowModule, 'Window module should be available');
    t.ok(windowModule.document, 'Window module should have document');
    t.ok(windowModule.document.createElement, 'Document should have createElement');
    
    // Test canvas creation through the mock
    const canvas = windowModule.document.createElement('canvas');
    t.ok(canvas, 'Should be able to create canvas element');
    t.equal(canvas.width, 800, 'Canvas should have default width');
    t.equal(canvas.height, 600, 'Canvas should have default height');
    
    // Test 2D context
    const ctx = canvas.getContext('2d');
    t.ok(ctx, 'Should be able to get 2d context');
    t.ok(ctx.fillRect, 'Context should have fillRect method');
    t.ok(ctx.strokeRect, 'Context should have strokeRect method');
    t.ok(ctx.fillText, 'Context should have fillText method');
    
    t.end();
});

test('AWT with isomorphic window - integration test', (t) => {
    // Test that AWT could potentially use the isomorphic window pattern
    const awt = require('../src/awt');
    const windowModule = require('../src/isomorphic/window.node.js');
    const { Canvas } = awt;
    
    const canvas = new Canvas();
    const graphics = canvas.getGraphics();
    
    // Verify that AWT still works correctly in CLI
    t.ok(canvas instanceof awt.Component, 'Canvas should be a component');
    t.ok(graphics, 'Should be able to get graphics context');
    
    // Test drawing operations
    graphics.setColor({ r: 100, g: 150, b: 200 });
    graphics.fillRect(5, 5, 20, 20);
    
    const operations = graphics.getOperations();
    t.ok(operations.includes('setColor(100, 150, 200)'), 'Should record setColor operation');
    t.ok(operations.includes('fillRect(5, 5, 20, 20)'), 'Should record fillRect operation');
    
    // Test that window mock has essential functionality that AWT might need
    t.ok(typeof windowModule.setTimeout === 'function', 'Window should have setTimeout');
    t.ok(windowModule.console, 'Window should have console');
    
    t.end();
});