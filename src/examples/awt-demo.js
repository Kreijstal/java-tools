/**
 * Example AWT Demo that shows how to integrate the JavaScript AWT framework
 * with the JVM execution environment.
 */

const { Canvas, Frame, AwtMouseEvent, Component } = require('../awt');

/**
 * Simple AWT demo class that creates a canvas and handles mouse events
 */
class AwtDemo {
    constructor() {
        this.frame = new Frame('AWT Demo');
        this.canvas = new Canvas();
        this.setupComponents();
        this.setupEventHandlers();
    }
    
    setupComponents() {
        // Set up frame
        this.frame.setSize(800, 600);
        this.frame.add(this.canvas);
        
        // Set up canvas
        this.canvas.setSize(780, 580);
        this.canvas.setLocation(10, 10);
    }
    
    setupEventHandlers() {
        // Add mouse listener for drawing
        this.canvas.addMouseListener({
            mousePressed: (event) => {
                this.drawAt(event.getX(), event.getY());
            },
            mouseClicked: (event) => {
                console.log(`Mouse clicked at: ${event.getX()}, ${event.getY()}`);
            }
        });
        
        // Add mouse motion listener for drag drawing
        this.canvas.addMouseMotionListener({
            mouseDragged: (event) => {
                this.drawAt(event.getX(), event.getY());
            }
        });
        
        // Add key listener for keyboard shortcuts
        this.canvas.addKeyListener({
            keyPressed: (event) => {
                if (event.getKeyChar() === 'c' || event.getKeyChar() === 'C') {
                    this.clearCanvas();
                }
            }
        });
    }
    
    drawAt(x, y) {
        const graphics = this.canvas.getGraphics();
        graphics.setColor({ r: 255, g: 0, b: 0 }); // Red color
        graphics.fillRect(x - 2, y - 2, 4, 4); // Small square
        console.log(`Drawing at: ${x}, ${y}`);
    }
    
    clearCanvas() {
        const graphics = this.canvas.getGraphics();
        graphics.setColor({ r: 255, g: 255, b: 255 }); // White color
        graphics.fillRect(0, 0, this.canvas.width, this.canvas.height);
        console.log('Canvas cleared');
    }
    
    show() {
        this.frame.setVisible(true);
        console.log('AWT Demo window is now visible');
    }
    
    // Method to integrate with browser environment
    attachToDOM(canvasElement) {
        if (typeof document !== 'undefined' && canvasElement) {
            this.canvas.setCanvasElement(canvasElement);
            console.log('AWT Canvas attached to DOM element');
        }
    }
}

// Export for use in both Node.js and browser environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AwtDemo;
}

// Example usage for CLI testing
if (require.main === module) {
    console.log('=== AWT Demo CLI Test ===');
    
    const demo = new AwtDemo();
    demo.show();
    
    // Simulate some mouse events for testing
    const mouseEvent1 = new AwtMouseEvent(demo.canvas, 501, 100, 150, 1, false);
    demo.canvas.processMouseEvent(mouseEvent1);
    
    const mouseEvent2 = new AwtMouseEvent(demo.canvas, 501, 200, 250, 1, false);
    demo.canvas.processMouseEvent(mouseEvent2);
    
    // Get graphics operations for verification
    const graphics = demo.canvas.getGraphics();
    if (graphics.getOperations) {
        console.log('\nGraphics operations performed:');
        graphics.getOperations().forEach(op => console.log(`  ${op}`));
    }
    
    console.log('\n=== Demo Complete ===');
}