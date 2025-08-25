/**
 * Node.js window implementation for isomorphic JavaScript.
 * This module provides a mock window object for Node.js environments that don't have DOM support.
 * It creates a minimal window-like object that includes document and essential browser APIs for testing.
 */

// Create a minimal mock window object for CLI/Node.js environments
const mockWindow = {
    // Mock document for basic compatibility
    document: {
        createElement: (tagName) => {
            // Return a mock element with essential Canvas functionality
            if (tagName === 'canvas') {
                return {
                    width: 800,
                    height: 600,
                    style: {},
                    getContext: (type) => {
                        if (type === '2d') {
                            // Return a mock Canvas 2D context for CLI testing
                            return {
                                canvas: { width: 800, height: 600 },
                                fillStyle: '#000000',
                                strokeStyle: '#000000',
                                font: '10px sans-serif',
                                fillRect: () => {},
                                strokeRect: () => {},
                                fillText: () => {},
                                drawImage: () => {},
                                clearRect: () => {},
                                beginPath: () => {},
                                closePath: () => {},
                                moveTo: () => {},
                                lineTo: () => {},
                                stroke: () => {},
                                fill: () => {}
                            };
                        }
                        return null;
                    },
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 })
                };
            }
            
            // Generic mock element
            return {
                tagName: tagName.toUpperCase(),
                style: {},
                classList: {
                    add: () => {},
                    remove: () => {},
                    contains: () => false
                },
                appendChild: () => {},
                removeChild: () => {},
                addEventListener: () => {},
                removeEventListener: () => {},
                setAttribute: () => {},
                getAttribute: () => null
            };
        },
        
        // Mock body for appendChild operations
        body: {
            appendChild: () => {},
            removeChild: () => {}
        },
        
        // Mock query selectors
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null
    },
    
    // Mock console (use Node.js console)
    console: console,
    
    // Mock setTimeout/setInterval
    setTimeout: global.setTimeout,
    setInterval: global.setInterval,
    clearTimeout: global.clearTimeout,
    clearInterval: global.clearInterval,
    
    // Mock location
    location: {
        href: 'http://localhost/',
        protocol: 'http:',
        host: 'localhost',
        pathname: '/',
        search: '',
        hash: ''
    },
    
    // Mock navigator
    navigator: {
        userAgent: 'Node.js AWT Mock',
        platform: process.platform
    },
    
    // Essential for AWT framework compatibility
    addEventListener: () => {},
    removeEventListener: () => {}
};

module.exports = mockWindow;