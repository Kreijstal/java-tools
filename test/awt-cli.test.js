const test = require('tape');
const awt = require('../src/platform/awt');
const browserInput = require('../src/platform/browser-awt-input');
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

test('browser AWT input bridge translates DOM input for guest listeners', (t) => {
    const handlers = new Map();
    const canvas = {
        width: 800,
        height: 600,
        style: {},
        addEventListener: (name, handler) => handlers.set(name, handler),
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 300 }),
        focus: () => {},
    };
    const calls = [];
    const jvm = {
        _awtCanvasElement: canvas,
        enqueueAwtEventInvocation: (listener, method, descriptor, event, coalesce) =>
            calls.push({ listener, method, descriptor, event, coalesce }),
    };
    const listener = { type: 'ArbitraryGuestListener' };
    const component = { _visible: true, _listeners: {
        mouse: [listener], mouseMotion: [listener], key: [listener],
    } };
    browserInput.registerInputComponent(jvm, component, 'mouse');
    browserInput.registerInputComponent(jvm, component, 'mouseMotion');
    browserInput.registerInputComponent(jvm, component, 'key');
    browserInput.focusInputComponent(jvm, component);
    browserInput.attachBrowserInput(jvm, canvas);
    const domEvent = (extra = {}) => ({
        clientX: 210, clientY: 170, button: 0, buttons: 1, detail: 1,
        shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
        preventDefault: () => {}, ...extra,
    });
    handlers.get('mousedown')(domEvent());
    handlers.get('mousemove')(domEvent());
    handlers.get('keydown')(domEvent({ key: 'ArrowUp', keyCode: 38, buttons: 0 }));

    t.equal(calls[0].method, 'mousePressed', 'DOM press selects the Java listener method');
    t.equal(calls[0].event.x, 400, 'CSS X is scaled into the canvas coordinate space');
    t.equal(calls[0].event.y, 300, 'CSS Y is scaled into the canvas coordinate space');
    t.equal(calls[0].event.button, 1, 'DOM primary button becomes AWT BUTTON1');
    t.equal(calls[1].method, 'mouseDragged', 'movement with a held button becomes a drag');
    t.ok(calls[1].coalesce, 'high-frequency pointer movement is coalescible');
    t.equal(calls[2].method, 'keyPressed', 'focused key input selects keyPressed');
    t.equal(calls[2].event.keyCode, 38, 'browser arrow code is retained as the AWT code');
    t.equal(calls.length, 3, 'non-character arrows do not manufacture keyTyped');
    t.end();
});

test('browser AWT input bridge scopes a concrete canvas to its Java component', (t) => {
    const handlers = new Map();
    const canvas = {
        width: 320, height: 200, style: {},
        addEventListener: (name, handler) => handlers.set(name, handler),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 200 }),
        focus: () => {},
    };
    const calls = [];
    const jvm = {
        enqueueAwtEventInvocation: (listener, method, descriptor, event) =>
            calls.push({ listener, method, descriptor, event }),
    };
    const firstListener = { type: 'FirstListener' };
    const secondListener = { type: 'SecondListener' };
    const first = { _visible: true, _canvasElement: canvas,
        _listeners: { mouse: [firstListener] } };
    const second = { _visible: true, _listeners: { mouse: [secondListener] } };
    browserInput.registerInputComponent(jvm, first, 'mouse');
    browserInput.registerInputComponent(jvm, second, 'mouse');
    browserInput.attachBrowserInput(jvm, canvas, first);
    handlers.get('mousedown')({
        clientX: 12, clientY: 34, button: 0, buttons: 1, detail: 1,
        shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
        preventDefault() {},
    });

    t.equal(calls.length, 1, 'one concrete canvas dispatches only one component');
    t.equal(calls[0].listener, firstListener,
        'the event reaches the listener registered on the clicked component');
    t.equal(jvm._awtFocusedComponent, first,
        'mousedown focuses the Java component owning the concrete canvas');
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
