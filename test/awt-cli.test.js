const test = require('tape');
const awt = require('../src/awt');
const { Canvas, Frame, Component, AwtMouseEvent, AwtKeyEvent } = awt;

test('AWT framework - CLI compatibility with mocks', (t) => {
    // Test that AWT components work in CLI environment
    const canvas = new Canvas();
    const frame = new Frame('Test Frame');
    
    t.ok(canvas instanceof Component, 'Canvas should be a Component');
    t.ok(frame instanceof Component, 'Frame should be a Component');
    
    // Test canvas graphics in CLI environment (should use MockGraphics)
    const graphics = canvas.getGraphics();
    t.ok(graphics && graphics.constructor.name === 'MockGraphics', 'Canvas should use MockGraphics in CLI environment');
    
    // Test drawing operations
    graphics.setColor({ r: 255, g: 0, b: 0 });
    graphics.fillRect(10, 10, 100, 50);
    graphics.drawString('Hello AWT', 20, 30);
    
    const operations = graphics.getOperations();
    t.ok(operations.includes('setColor(255, 0, 0)'), 'Should record setColor operation');
    t.ok(operations.includes('fillRect(10, 10, 100, 50)'), 'Should record fillRect operation');
    t.ok(operations.includes('drawString("Hello AWT", 20, 30)'), 'Should record drawString operation');
    
    t.end();
});

test('AWT framework - Image handling in CLI', (t) => {
    const canvas = new Canvas();
    const image = canvas.createImage(200, 150);
    
    t.ok(image && image.constructor.name === 'MockImage', 'Should create MockImage in CLI environment');
    t.equal(image.getWidth(), 200, 'Image should have correct width');
    t.equal(image.getHeight(), 150, 'Image should have correct height');
    
    const imageGraphics = image.getGraphics();
    t.ok(imageGraphics && imageGraphics.constructor.name === 'MockGraphics', 'Image graphics should be MockGraphics in CLI');
    
    t.end();
});

test('AWT framework - Event handling', (t) => {
    const canvas = new Canvas();
    let mousePressed = false;
    let keyPressed = false;
    
    // Add event listeners
    canvas.addMouseListener({
        mousePressed: (event) => {
            mousePressed = true;
            t.equal(event.getX(), 50, 'Mouse event should have correct X coordinate');
            t.equal(event.getY(), 75, 'Mouse event should have correct Y coordinate');
        }
    });
    
    canvas.addKeyListener({
        keyPressed: (event) => {
            keyPressed = true;
            t.equal(event.getKeyCode(), 65, 'Key event should have correct key code');
        }
    });
    
    // Simulate events
    const mouseEvent = new AwtMouseEvent(canvas, 501, 50, 75, 1, false);
    canvas.processMouseEvent(mouseEvent);
    
    const keyEvent = new AwtKeyEvent(canvas, 401, 65, 'A');
    canvas.processKeyEvent(keyEvent);
    
    t.ok(mousePressed, 'Mouse event should be processed');
    t.ok(keyPressed, 'Key event should be processed');
    
    t.end();
});

test('AWT framework - Component hierarchy', (t) => {
    const frame = new Frame('Test Frame');
    const canvas = new Canvas();
    
    frame.add(canvas);
    
    t.equal(canvas.getParent(), frame, 'Canvas parent should be frame');
    t.equal(frame.components.length, 1, 'Frame should have one component');
    t.equal(frame.components[0], canvas, 'Frame first component should be canvas');
    
    frame.remove(canvas);
    t.equal(frame.components.length, 0, 'Frame should have no components after removal');
    t.notEqual(canvas.getParent(), frame, 'Canvas should not have frame as parent after removal');
    
    t.end();
});

test('AWT framework - Frame operations', (t) => {
    const frame = new Frame('Test Window');
    
    frame.setSize(800, 600);
    frame.setVisible(true);
    frame.setBounds(100, 100, 640, 480);
    
    t.equal(frame.width, 640, 'Frame should have correct width');
    t.equal(frame.height, 480, 'Frame should have correct height');
    t.equal(frame.x, 100, 'Frame should have correct x position');
    t.equal(frame.y, 100, 'Frame should have correct y position');
    t.ok(frame.visible, 'Frame should be visible');
    
    const insets = frame.getInsets();
    t.equal(typeof insets, 'object', 'Frame should return insets');
    t.ok('top' in insets && 'left' in insets, 'Insets should have required properties');
    
    t.end();
});