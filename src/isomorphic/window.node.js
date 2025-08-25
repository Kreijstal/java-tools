/**
 * Node.js window implementation for isomorphic JavaScript.
 * This module uses JSDOM to create a complete DOM environment in Node.js.
 * It provides a realistic browser-like environment for server-side rendering and testing.
 */

const { JSDOM } = require('jsdom');

// Create a new JSDOM instance with a basic HTML document
const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body></body></html>`, {
    // Configure JSDOM to simulate a browser environment
    url: "http://localhost/",
    referrer: "http://localhost/",
    contentType: "text/html",
    includeNodeLocations: true,
    storageQuota: 10000000,
    
    // Configure window features
    features: {
        FetchExternalResources: false,
        ProcessExternalResources: false,
        SkipExternalResources: false
    },
    
    // Add Canvas support through a mock implementation
    beforeParse(window) {
        // Add Canvas 2D context support for AWT graphics operations
        const originalCreateElement = window.document.createElement.bind(window.document);
        window.document.createElement = function(tagName) {
            const element = originalCreateElement(tagName);
            
            if (tagName.toLowerCase() === 'canvas') {
                // Enhance canvas elements with proper 2D context mock
                element.getContext = function(type) {
                    if (type === '2d') {
                        return {
                            canvas: element,
                            fillStyle: '#000000',
                            strokeStyle: '#000000',
                            font: '10px sans-serif',
                            lineWidth: 1,
                            
                            // Drawing operations that record actions for testing
                            fillRect: function(x, y, width, height) {
                                this._recordOperation('fillRect', x, y, width, height);
                            },
                            strokeRect: function(x, y, width, height) {
                                this._recordOperation('strokeRect', x, y, width, height);
                            },
                            fillText: function(text, x, y, maxWidth) {
                                this._recordOperation('fillText', text, x, y, maxWidth);
                            },
                            strokeText: function(text, x, y, maxWidth) {
                                this._recordOperation('strokeText', text, x, y, maxWidth);
                            },
                            drawImage: function(image, sx, sy, sw, sh, dx, dy, dw, dh) {
                                const args = Array.from(arguments);
                                this._recordOperation('drawImage', ...args);
                            },
                            clearRect: function(x, y, width, height) {
                                this._recordOperation('clearRect', x, y, width, height);
                            },
                            
                            // Path operations
                            beginPath: function() {
                                this._recordOperation('beginPath');
                            },
                            closePath: function() {
                                this._recordOperation('closePath');
                            },
                            moveTo: function(x, y) {
                                this._recordOperation('moveTo', x, y);
                            },
                            lineTo: function(x, y) {
                                this._recordOperation('lineTo', x, y);
                            },
                            arc: function(x, y, radius, startAngle, endAngle, counterclockwise) {
                                this._recordOperation('arc', x, y, radius, startAngle, endAngle, counterclockwise);
                            },
                            stroke: function() {
                                this._recordOperation('stroke');
                            },
                            fill: function() {
                                this._recordOperation('fill');
                            },
                            
                            // Transformation operations
                            save: function() {
                                this._recordOperation('save');
                            },
                            restore: function() {
                                this._recordOperation('restore');
                            },
                            translate: function(x, y) {
                                this._recordOperation('translate', x, y);
                            },
                            rotate: function(angle) {
                                this._recordOperation('rotate', angle);
                            },
                            scale: function(x, y) {
                                this._recordOperation('scale', x, y);
                            },
                            
                            // Operation recording for testing
                            _operations: [],
                            _recordOperation: function(operation, ...args) {
                                this._operations.push({
                                    operation: operation,
                                    args: args,
                                    timestamp: Date.now()
                                });
                            },
                            
                            // Get recorded operations for testing
                            getOperations: function() {
                                return this._operations.map(op => 
                                    op.args.length > 0 ? 
                                    `${op.operation}(${op.args.join(', ')})` : 
                                    `${op.operation}()`
                                );
                            },
                            
                            // Clear recorded operations
                            clearOperations: function() {
                                this._operations = [];
                            }
                        };
                    }
                    return null;
                };
                
                // Set default canvas dimensions
                element.width = 800;
                element.height = 600;
            }
            
            return element;
        };
    }
});

// Export the window object from our JSDOM instance
// This provides a complete DOM environment including document, navigator, location, etc.
module.exports = dom.window;