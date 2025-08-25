/**
 * Browser AWT Integration Demo
 * This script shows how to integrate the AWT framework with the browser-based JVM environment
 */

// Wait for AWT framework to be loaded
document.addEventListener('DOMContentLoaded', function() {
    if (typeof window.Canvas !== 'undefined' && typeof window.Frame !== 'undefined') {
        initializeAWTDemo();
    } else {
        // Try loading AWT dynamically if not available
        loadAwtFramework().then(() => {
            initializeAWTDemo();
        }).catch(error => {
            console.warn('AWT Framework not available:', error.message);
        });
    }
});

/**
 * Load AWT framework dynamically if not already loaded
 */
function loadAwtFramework() {
    return new Promise((resolve, reject) => {
        if (typeof window.Canvas !== 'undefined') {
            resolve();
            return;
        }
        
        const script = document.createElement('script');
        script.src = './awt.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load AWT framework'));
        document.head.appendChild(script);
    });
}

/**
 * Initialize AWT demo integration
 */
function initializeAWTDemo() {
    console.log('🎨 Initializing AWT Framework integration...');
    
    // Add AWT demo section to the UI
    addAwtDemoSection();
    
    // Set up AWT canvas integration
    setupAwtCanvasDemo();
    
    console.log('✅ AWT Framework integration complete');
}

/**
 * Add AWT demo section to the UI
 */
function addAwtDemoSection() {
    const statePanelStack = document.querySelector('.state-panel-stack');
    if (!statePanelStack) {
        console.warn('State panel stack not found, cannot add AWT demo');
        return;
    }
    
    const awtPanel = document.createElement('div');
    awtPanel.className = 'panel';
    awtPanel.innerHTML = `
        <h3>🎨 AWT Framework Demo</h3>
        <p>This demonstrates the JavaScript AWT framework running in the browser.</p>
        
        <div id="awt-demo-controls" style="margin: 10px 0;">
            <button id="awt-create-canvas" onclick="createAwtCanvas()">Create AWT Canvas</button>
            <button id="awt-clear-canvas" onclick="clearAwtCanvas()">Clear Canvas</button>
            <button id="awt-test-drawing" onclick="testAwtDrawing()">Test Drawing</button>
        </div>
        
        <div id="awt-canvas-container" style="border: 1px solid #3e3e42; margin: 10px 0; min-height: 200px; background: #1e1e1e;">
            <canvas id="awt-demo-canvas" width="400" height="200" style="background: white; display: none;"></canvas>
            <div id="awt-placeholder" style="padding: 20px; color: #888; text-align: center;">
                Click "Create AWT Canvas" to initialize the AWT framework demo
            </div>
        </div>
        
        <div id="awt-operations-log" style="background: #2d3748; color: #e2e8f0; padding: 10px; margin: 10px 0; font-family: monospace; font-size: 12px; max-height: 150px; overflow-y: auto;">
            <div>Ready to demonstrate AWT operations...</div>
        </div>
    `;
    
    statePanelStack.appendChild(awtPanel);
}

/**
 * Set up AWT canvas demo functionality
 */
function setupAwtCanvasDemo() {
    // Create global variables for AWT demo
    window.awtDemo = {
        canvas: null,
        frame: null,
        graphics: null
    };
    
    // Define global functions for button handlers
    window.createAwtCanvas = createAwtCanvas;
    window.clearAwtCanvas = clearAwtCanvas;
    window.testAwtDrawing = testAwtDrawing;
}

/**
 * Create AWT canvas and integrate with DOM
 */
function createAwtCanvas() {
    try {
        logAwtOperation('Creating AWT Canvas...');
        
        // Import AWT classes (they should be global after loading awt.js)
        const { Canvas, Frame } = window;
        
        if (!Canvas || !Frame) {
            throw new Error('AWT classes not available. Make sure awt.js is loaded.');
        }
        
        // Create AWT components
        window.awtDemo.frame = new Frame('Browser AWT Demo');
        window.awtDemo.canvas = new Canvas();
        
        // Set up canvas
        window.awtDemo.canvas.setSize(400, 200);
        window.awtDemo.frame.add(window.awtDemo.canvas);
        
        // Get DOM canvas element and connect it
        const domCanvas = document.getElementById('awt-demo-canvas');
        if (domCanvas) {
            window.awtDemo.canvas.setCanvasElement(domCanvas);
            domCanvas.style.display = 'block';
            
            // Hide placeholder
            const placeholder = document.getElementById('awt-placeholder');
            if (placeholder) placeholder.style.display = 'none';
        }
        
        // Get graphics context
        window.awtDemo.graphics = window.awtDemo.canvas.getGraphics();
        
        // Add event listeners
        window.awtDemo.canvas.addMouseListener({
            mousePressed: (event) => {
                logAwtOperation(`Mouse pressed at: (${event.getX()}, ${event.getY()})`);
                drawDotAt(event.getX(), event.getY());
            },
            mouseClicked: (event) => {
                logAwtOperation(`Mouse clicked at: (${event.getX()}, ${event.getY()})`);
            }
        });
        
        window.awtDemo.canvas.addMouseMotionListener({
            mouseDragged: (event) => {
                drawDotAt(event.getX(), event.getY());
            }
        });
        
        // Initial drawing
        window.awtDemo.graphics.setColor({ r: 200, g: 200, b: 200 });
        window.awtDemo.graphics.fillRect(0, 0, 400, 200);
        
        window.awtDemo.graphics.setColor({ r: 0, g: 0, b: 0 });
        window.awtDemo.graphics.drawString('AWT Framework Demo - Click and drag to draw!', 10, 20);
        
        logAwtOperation('✅ AWT Canvas created successfully');
        
    } catch (error) {
        logAwtOperation(`❌ Error creating AWT Canvas: ${error.message}`);
        console.error('AWT Canvas creation error:', error);
    }
}

/**
 * Clear the AWT canvas
 */
function clearAwtCanvas() {
    try {
        if (!window.awtDemo.graphics) {
            logAwtOperation('⚠️  No AWT canvas to clear');
            return;
        }
        
        logAwtOperation('Clearing AWT canvas...');
        
        // Clear with white background
        window.awtDemo.graphics.setColor({ r: 255, g: 255, b: 255 });
        window.awtDemo.graphics.fillRect(0, 0, 400, 200);
        
        // Add border
        window.awtDemo.graphics.setColor({ r: 0, g: 0, b: 0 });
        window.awtDemo.graphics.drawRect(0, 0, 399, 199);
        
        // Add text
        window.awtDemo.graphics.drawString('AWT Canvas Cleared - Ready for drawing!', 10, 20);
        
        logAwtOperation('✅ AWT canvas cleared');
        
    } catch (error) {
        logAwtOperation(`❌ Error clearing canvas: ${error.message}`);
    }
}

/**
 * Test AWT drawing operations
 */
function testAwtDrawing() {
    try {
        if (!window.awtDemo.graphics) {
            logAwtOperation('⚠️  Create AWT canvas first');
            return;
        }
        
        logAwtOperation('Testing AWT drawing operations...');
        
        const graphics = window.awtDemo.graphics;
        
        // Clear canvas
        graphics.setColor({ r: 255, g: 255, b: 255 });
        graphics.fillRect(0, 0, 400, 200);
        
        // Draw rectangles
        graphics.setColor({ r: 255, g: 0, b: 0 });
        graphics.fillRect(50, 50, 60, 40);
        
        graphics.setColor({ r: 0, g: 255, b: 0 });
        graphics.fillRect(130, 50, 60, 40);
        
        graphics.setColor({ r: 0, g: 0, b: 255 });
        graphics.fillRect(210, 50, 60, 40);
        
        // Draw outlined rectangles
        graphics.setColor({ r: 0, g: 0, b: 0 });
        graphics.drawRect(50, 110, 60, 40);
        graphics.drawRect(130, 110, 60, 40);
        graphics.drawRect(210, 110, 60, 40);
        
        // Draw text
        graphics.setFont({ name: 'Arial', style: 1, size: 14 }); // Bold
        graphics.drawString('AWT Graphics Test', 290, 30);
        
        graphics.setFont({ name: 'Courier', style: 0, size: 12 }); // Normal
        graphics.drawString('Rectangles and Text', 290, 60);
        graphics.drawString('CLI-compatible!', 290, 80);
        
        logAwtOperation('✅ AWT drawing test complete');
        
    } catch (error) {
        logAwtOperation(`❌ Error testing drawing: ${error.message}`);
    }
}

/**
 * Draw a small dot at the specified coordinates
 */
function drawDotAt(x, y) {
    if (window.awtDemo.graphics) {
        window.awtDemo.graphics.setColor({ r: 255, g: 0, b: 0 });
        window.awtDemo.graphics.fillRect(x - 2, y - 2, 4, 4);
    }
}

/**
 * Log AWT operations to the demo log
 */
function logAwtOperation(message) {
    const log = document.getElementById('awt-operations-log');
    if (log) {
        const entry = document.createElement('div');
        entry.style.margin = '2px 0';
        entry.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
    }
    console.log(`[AWT Demo] ${message}`);
}