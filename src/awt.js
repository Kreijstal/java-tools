// =======================================================================
// file: awt.js
// Description: A JavaScript implementation of the AWT-on-Canvas API,
// fully documented with JSDoc for type-checking and IntelliSense.
// =======================================================================

// --- Type Definitions for Data Structures and Interfaces ---

/**
 * @typedef {object} AwtPoint
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {object} AwtDimension
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} AwtRectangle
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} AwtInsets
 * @property {number} top
 * @property {number} left
 * @property {number} bottom
 * @property {number} right
 */

/**
 * @typedef {object} AwtColor
 * @property {number} r - Red component (0-255)
 * @property {number} g - Green component (0-255)
 * @property {number} b - Blue component (0-255)
 */

/**
 * @typedef {object} AwtFont
 * @property {string} name
 * @property {0 | 1 | 2} style - Font style: 0 for PLAIN, 1 for BOLD, 2 for ITALIC.
 * @property {number} size
 */

/**
 * @interface
 * @description Represents a drawable image.
 */
class AwtImage {
    /** @returns {IGraphics} */
    getGraphics() { throw new Error("Not implemented"); }
    /** @param {AwtImageObserver} [observer] @returns {number} */
    getWidth(observer) { throw new Error("Not implemented"); }
    /** @param {AwtImageObserver} [observer] @returns {number} */
    getHeight(observer) { throw new Error("Not implemented"); }
}

/**
 * @interface
 * @description Marker interface for tracking image loading.
 */
class AwtImageObserver {}

/**
 * @interface
 * @description Provides the drawing context for a component.
 */
class IGraphics {
    /** @param {AwtColor} color */
    setColor(color) {}
    /** @param {number} x @param {number} y @param {number} width @param {number} height */
    fillRect(x, y, width, height) {}
    /** @param {number} x @param {number} y @param {number} width @param {number} height */
    drawRect(x, y, width, height) {}
    /** @param {AwtFont} font */
    setFont(font) {}
    /** @param {string} str @param {number} x @param {number} y */
    drawString(str, x, y) {}
    /** @param {AwtImage} image @param {number} x @param {number} y @param {AwtImageObserver} [observer] @returns {boolean} */
    drawImage(image, x, y, observer) { return false; }
    /** @returns {AwtRectangle} */
    getClipBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
    dispose() {}
}

/**
 * @interface
 * @description Base interface for all AWT event listeners.
 */
class AwtEventListener {}

/**
 * @interface
 * @extends {AwtEventListener}
 */
class AwtMouseListener {
    /** @param {AwtMouseEvent} event */
    mousePressed(event) {}
    /** @param {AwtMouseEvent} event */
    mouseReleased(event) {}
    /** @param {AwtMouseEvent} event */
    mouseClicked(event) {}
    /** @param {AwtMouseEvent} event */
    mouseEntered(event) {}
    /** @param {AwtMouseEvent} event */
    mouseExited(event) {}
}

/** @interface @extends {AwtEventListener} */
class AwtMouseMotionListener {
    /** @param {AwtMouseEvent} event */
    mouseMoved(event) {}
    /** @param {AwtMouseEvent} event */
    mouseDragged(event) {}
}

/** @interface @extends {AwtEventListener} */
class AwtKeyListener {
    /** @param {AwtKeyEvent} event */
    keyPressed(event) {}
    /** @param {AwtKeyEvent} event */
    keyReleased(event) {}
    /** @param {AwtKeyEvent} event */
    keyTyped(event) {}
}

/** @interface @extends {AwtEventListener} */
class AwtMouseWheelListener {
    /** @param {AwtMouseWheelEvent} event */
    mouseWheelMoved(event) {}
}

/** @interface @extends {AwtEventListener} */
class AwtFocusListener {
    /** @param {AwtFocusEvent} event */
    focusGained(event) {}
    /** @param {AwtFocusEvent} event */
    focusLost(event) {}
}


// Note: Window namespace pollution removed. AWT classes are now available 
// only through CommonJS exports to avoid polluting the global namespace.

// --- Event Classes ---

class AwtEvent {
    /** @private @type {object} */
    source;
    /** @private @type {number} */
    id;
    /** @private @type {boolean} */
    consumed = false;

    /**
     * @param {object} source
     * @param {number} id
     */
    constructor(source, id) {
        this.source = source;
        this.id = id;
    }

    /** @returns {object} */
    getSource() { return this.source; }

    /** @returns {number} */
    getID() { return this.id; }

    consume() { this.consumed = true; }

    /** @returns {boolean} */
    isConsumed() { return this.consumed; }
}

class AwtMouseEvent extends AwtEvent {
    /** @private @type {number} */ x;
    /** @private @type {number} */ y;
    /** @private @type {number} */ modifiers;
    /** @private @type {number} */ clickCount;
    /** @private @type {boolean} */ popupTrigger;

    /**
     * @param {object} source
     * @param {number} id
     * @param {number} x
     * @param {number} y
     * @param {number} clickCount
     * @param {boolean} popupTrigger
     */
    constructor(source, id, x, y, clickCount, popupTrigger) {
        super(source, id);
        this.x = x;
        this.y = y;
        this.clickCount = clickCount;
        this.popupTrigger = popupTrigger;
        this.modifiers = 0; // Simplified
    }

    /** @returns {number} */ getX() { return this.x; }
    /** @returns {number} */ getY() { return this.y; }
    /** @returns {number} */ getModifiers() { return this.modifiers; }
    /** @returns {boolean} */ isPopupTrigger() { return this.popupTrigger; }
    /** @returns {number} */ getClickCount() { return this.clickCount; }
}

class AwtKeyEvent extends AwtEvent {
    /** @private @type {number} */ keyCode;
    /** @private @type {string} */ keyChar;
    /** @private @type {number} */ modifiers;

    /**
     * @param {object} source
     * @param {number} id
     * @param {number} keyCode
     * @param {string} keyChar
     */
    constructor(source, id, keyCode, keyChar) {
        super(source, id);
        this.keyCode = keyCode;
        this.keyChar = keyChar;
        this.modifiers = 0; // Simplified
    }

    /** @returns {number} */ getKeyCode() { return this.keyCode; }
    /** @returns {string} */ getKeyChar() { return this.keyChar; }
    /** @returns {number} */ getModifiers() { return this.modifiers; }
}

class AwtMouseWheelEvent extends AwtMouseEvent {
    /** @private @type {number} */ wheelRotation;

    /**
     * @param {object} source
     * @param {number} id
     * @param {number} x
     * @param {number} y
     * @param {number} wheelRotation
     */
    constructor(source, id, x, y, wheelRotation) {
        super(source, id, x, y, 1, false);
        this.wheelRotation = wheelRotation;
    }

    /** @returns {number} */ getWheelRotation() { return this.wheelRotation; }
}

class AwtFocusEvent extends AwtEvent {
    /** @param {object} source @param {number} id */
    constructor(source, id) { super(source, id); }
}

class AwtActionEvent extends AwtEvent {
    /** @private @type {string} */ command;

    /** @param {object} source @param {number} id @param {string} command */
    constructor(source, id, command) {
        super(source, id);
        this.command = command;
    }

    /** @returns {string} */ getActionCommand() { return this.command; }
}


// --- Component Hierarchy ---

class Component {
    /** @protected @type {Container | null} */ parent = null;
    /** @protected @type {number} */ x = 0;
    /** @protected @type {number} */ y = 0;
    /** @protected @type {number} */ width = 0;
    /** @protected @type {number} */ height = 0;
    /** @protected @type {boolean} */ visible = true;
    /** @private @type {AwtMouseListener[]} */ mouseListeners = [];
    /** @private @type {AwtMouseMotionListener[]} */ mouseMotionListeners = [];
    /** @private @type {AwtMouseWheelListener[]} */ mouseWheelListeners = [];
    /** @private @type {AwtKeyListener[]} */ keyListeners = [];
    /** @private @type {AwtFocusListener[]} */ focusListeners = [];
    /** @private @type {AwtCursor | null} */ cursor = null;
    /** @private @type {boolean} */ focusTraversalKeysEnabled = true;

    /** @returns {any} */ getPeer() { return null; }

    /** @param {AwtMouseListener} listener */
    addMouseListener(listener) { this.mouseListeners.push(listener); }

    /** @param {AwtMouseListener} listener */
    removeMouseListener(listener) {
        const index = this.mouseListeners.indexOf(listener);
        if (index !== -1) this.mouseListeners.splice(index, 1);
    }

    /** @param {AwtMouseMotionListener} listener */
    addMouseMotionListener(listener) { this.mouseMotionListeners.push(listener); }

    /** @param {AwtMouseMotionListener} listener */
    removeMouseMotionListener(listener) {
        const index = this.mouseMotionListeners.indexOf(listener);
        if (index !== -1) this.mouseMotionListeners.splice(index, 1);
    }

    /** @param {AwtMouseWheelListener} listener */
    addMouseWheelListener(listener) { this.mouseWheelListeners.push(listener); }

    /** @param {AwtMouseWheelListener} listener */
    removeMouseWheelListener(listener) {
        const index = this.mouseWheelListeners.indexOf(listener);
        if (index !== -1) this.mouseWheelListeners.splice(index, 1);
    }

    /** @param {AwtKeyListener} listener */
    addKeyListener(listener) { this.keyListeners.push(listener); }

    /** @param {AwtKeyListener} listener */
    removeKeyListener(listener) {
        const index = this.keyListeners.indexOf(listener);
        if (index !== -1) this.keyListeners.splice(index, 1);
    }

    /** @param {AwtFocusListener} listener */
    addFocusListener(listener) { this.focusListeners.push(listener); }

    /** @param {AwtFocusListener} listener */
    removeFocusListener(listener) {
        const index = this.focusListeners.indexOf(listener);
        if (index !== -1) this.focusListeners.splice(index, 1);
    }

    /** @param {boolean} enabled */
    setFocusTraversalKeysEnabled(enabled) { this.focusTraversalKeysEnabled = enabled; }

    /** @param {IGraphics} g */
    update(g) { this.paint(g); }

    /** @param {IGraphics} g */
    paint(g) { /* Default implementation does nothing */ }

    /** @param {AwtCursor} cursor */
    setCursor(cursor) { this.cursor = cursor; }

    /** @returns {AwtToolkit} */
    getToolkit() { return AwtToolkit.getDefaultToolkit(); }

    /** @param {any} producer @returns {AwtImage} */
    createImage(producer) { return new CanvasImage(100, 100); }

    /** @param {AwtImage} image @param {AwtImageObserver} observer @returns {boolean} */
    prepareImage(image, observer) { return true; }

    /** @protected @param {AwtMouseEvent} e */
    processMouseEvent(e) {
        for (const listener of this.mouseListeners) {
            switch (e.getID()) {
                case 501: if (listener.mousePressed) listener.mousePressed(e); break; // MOUSE_PRESSED
                case 502: if (listener.mouseReleased) listener.mouseReleased(e); break; // MOUSE_RELEASED
                case 500: if (listener.mouseClicked) listener.mouseClicked(e); break; // MOUSE_CLICKED
                case 504: if (listener.mouseEntered) listener.mouseEntered(e); break; // MOUSE_ENTERED
                case 505: if (listener.mouseExited) listener.mouseExited(e); break; // MOUSE_EXITED
            }
        }
    }
    
    /** @protected @param {AwtMouseEvent} e */
    processMouseMotionEvent(e) {
        for (const listener of this.mouseMotionListeners) {
            switch (e.getID()) {
                case 503: if (listener.mouseMoved) listener.mouseMoved(e); break; // MOUSE_MOVED
                case 506: if (listener.mouseDragged) listener.mouseDragged(e); break; // MOUSE_DRAGGED
            }
        }
    }
    
    /** @protected @param {AwtMouseWheelEvent} e */
    processMouseWheelEvent(e) {
        for (const listener of this.mouseWheelListeners) {
            if (listener.mouseWheelMoved) listener.mouseWheelMoved(e);
        }
    }

    /** @protected @param {AwtKeyEvent} e */
    processKeyEvent(e) {
        for (const listener of this.keyListeners) {
            switch (e.getID()) {
                case 401: if (listener.keyPressed) listener.keyPressed(e); break; // KEY_PRESSED
                case 402: if (listener.keyReleased) listener.keyReleased(e); break; // KEY_RELEASED
                case 400: if (listener.keyTyped) listener.keyTyped(e); break; // KEY_TYPED
            }
        }
    }

    /** @protected @param {AwtFocusEvent} e */
    processFocusEvent(e) {
        for (const listener of this.focusListeners) {
            switch (e.getID()) {
                case 1004: if (listener.focusGained) listener.focusGained(e); break; // FOCUS_GAINED
                case 1005: if (listener.focusLost) listener.focusLost(e); break; // FOCUS_LOST
            }
        }
    }
}

class Container extends Component {
    /** @private @type {Component[]} */ components = [];
    /** @private @type {AwtColor | null} */ background = null;
    /** @private @type {any} */ layout = null;

    /** @returns {AwtDimension} */
    getSize() { return { width: this.width, height: this.height }; }

    /** @param {AwtColor} color */
    setBackground(color) { this.background = color; }

    /** @param {Component} component @returns {Component} */
    add(component) {
        this.components.push(component);
        component.parent = this;
        return component;
    }

    /** @param {Component} component */
    remove(component) {
        const index = this.components.indexOf(component);
        if (index !== -1) {
            this.components.splice(index, 1);
            component.parent = null;
        }
    }

    /** @param {any} manager */
    setLayout(manager) { this.layout = manager; }

    /** @override @param {IGraphics} g */
    paint(g) {
        if (this.background) {
            g.setColor(this.background);
            g.fillRect(0, 0, this.width, this.height);
        }
        for (const component of this.components) {
            if (component.visible) {
                // This would ideally create a translated graphics context
                component.update(g);
            }
        }
    }
}

class Canvas extends Component {
    /** @private @type {HTMLCanvasElement | null} */ canvasElement = null;
    /** @private @type {IGraphics | null} */ graphics = null;
    
    constructor() { super(); }
    
    /** @returns {IGraphics} */
    getGraphics() {
        console.log(`🖼️  Canvas.getGraphics() called`);
        console.log(`📋 Environment check: typeof document = ${typeof document}`);
        console.log(`🔍 canvasElement exists: ${!!this.canvasElement}`);

        if (!this.graphics && this.canvasElement) {
            const ctx = this.canvasElement.getContext('2d');
            if (ctx) {
                console.log(`✅ Creating CanvasGraphics with real canvas context`);
                this.graphics = new CanvasGraphics(ctx);
            } else {
                console.log(`❌ Failed to get 2D context from canvas`);
            }
        }

        // For CLI environments, create a mock graphics context
        if (!this.graphics) {
            console.log(`🎭 Creating MockGraphics (no canvas or CLI environment)`);
            this.graphics = this.createMockGraphics();
        }

        console.log(`🎨 Final graphics type: ${this.graphics.constructor.name}`);
        return this.graphics;
    }
    
    /** @private @returns {IGraphics} */
    createMockGraphics() {
        // For CLI testing, create a mock graphics implementation
        if (typeof document === 'undefined') {
            return new MockGraphics(this.width || 800, this.height || 600);
        }
        
        // Browser fallback
        const fallbackCtx = document.createElement('canvas').getContext('2d');
        return new CanvasGraphics(fallbackCtx);
    }
    
    /** @param {number} width @param {number} height @returns {AwtImage} */
    createImage(width, height) { 
        if (typeof document === 'undefined') {
            return new MockImage(width, height);
        }
        return new CanvasImage(width, height); 
    }

    repaint() {
        if (this.canvasElement) {
            const g = this.getGraphics();
            if (g) this.update(g);
        } else {
            // CLI mock repaint
            const g = this.getGraphics();
            if (g) this.update(g);
        }
    }
    
    /** @param {number} width @param {number} height */
    setSize(width, height) {
        this.width = width;
        this.height = height;
        if (this.canvasElement) {
            this.canvasElement.width = width;
            this.canvasElement.height = height;
        }
    }
    
    /** @param {boolean} visible */
    setVisible(visible) { this.visible = visible; }
    
    /** @param {number} x @param {number} y */
    setLocation(x, y) { this.x = x; this.y = y; }
    
    /** @returns {Container} */
    getParent() { return this.parent || new Container(); }
    
    requestFocus() { /* Simplified */ }
    
    /** @param {HTMLCanvasElement} canvas */
    setCanvasElement(canvas) {
        this.canvasElement = canvas;
        this.setSize(this.width || 800, this.height || 600);
        this.setupEventListeners();
        this.repaint();
    }
    
    /** @private */
    setupEventListeners() {
        if (!this.canvasElement || typeof document === 'undefined') return;
        
        this.canvasElement.addEventListener('mousedown', (e) => {
            const rect = this.canvasElement.getBoundingClientRect();
            const event = new AwtMouseEvent(this, 501, e.clientX - rect.left, e.clientY - rect.top, 1, e.button === 2);
            this.processMouseEvent(event);
        });

        this.canvasElement.addEventListener('mouseup', (e) => {
            const rect = this.canvasElement.getBoundingClientRect();
            const event = new AwtMouseEvent(this, 502, e.clientX - rect.left, e.clientY - rect.top, 1, e.button === 2);
            this.processMouseEvent(event);
        });

        this.canvasElement.addEventListener('mousemove', (e) => {
            const rect = this.canvasElement.getBoundingClientRect();
            const event = new AwtMouseEvent(this, 503, e.clientX - rect.left, e.clientY - rect.top, 0, false);
            this.processMouseMotionEvent(event);
        });

        this.canvasElement.addEventListener('wheel', (e) => {
            const rect = this.canvasElement.getBoundingClientRect();
            const event = new AwtMouseWheelEvent(this, 507, e.clientX - rect.left, e.clientY - rect.top, e.deltaY);
            this.processMouseWheelEvent(event);
        });

        // Key events require the canvas to be focusable
        this.canvasElement.tabIndex = 0;
        this.canvasElement.addEventListener('keydown', (e) => {
            const event = new AwtKeyEvent(this, 401, e.keyCode, e.key);
            this.processKeyEvent(event);
        });

        this.canvasElement.addEventListener('keyup', (e) => {
            const event = new AwtKeyEvent(this, 402, e.keyCode, e.key);
            this.processKeyEvent(event);
        });
    }
}

class Window extends Container {}

class Frame extends Window {
    /** @private @type {string} */ title;
    /** @private @type {boolean} */ resizable = true;
    /** @private @type {boolean} */ undecorated = false;
    
    /** @param {string} [title] */
    constructor(title) { super(); this.title = title || ''; }
    
    pack() { if (this.components.length > 0) { this.width = 800; this.height = 600; } }
    
    dispose() { this.visible = false; }
    
    /** @param {boolean} resizable */
    setResizable(resizable) { this.resizable = resizable; }
    
    /** @param {boolean} visible */
    setVisible(visible) { this.visible = visible; }
    
    /** @param {number} x @param {number} y @param {number} width @param {number} height */
    setBounds(x, y, width, height) { this.x = x; this.y = y; this.width = width; this.height = height; }
    
    /** @param {number} width @param {number} height */
    setSize(width, height) { this.width = width; this.height = height; }
    
    toFront() { /* Simplified */ }
    
    requestFocus() { /* Simplified */ }
    
    /** @returns {AwtInsets} */
    getInsets() { return { top: 0, left: 0, bottom: 0, right: 0 }; }
    
    /** @param {boolean} undecorated */
    setUndecorated(undecorated) { this.undecorated = undecorated; }
    
    /** @param {boolean} enable */
    enableInputMethods(enable) { /* Simplified */ }
}


// --- Toolkit and Resource Management ---

class AwtCursor {}

class AwtToolkit {
    /** @private @type {AwtToolkit} */
    static instance;

    /** @returns {AwtToolkit} */
    static getDefaultToolkit() {
        if (!AwtToolkit.instance) AwtToolkit.instance = new AwtToolkit();
        return AwtToolkit.instance;
    }

    /** @param {Uint8Array} data @returns {AwtImage} */
    createImage(data) { 
        if (typeof document === 'undefined') {
            return new MockImage(100, 100);
        }
        return new CanvasImage(100, 100); 
    }
    
    /** @returns {AwtClipboard} */
    getSystemClipboard() { return new AwtClipboard(); }
    
    /** @returns {AwtEventQueue} */
    getSystemEventQueue() { return new AwtEventQueue(); }
    
    /** @param {AwtImage} image @param {AwtPoint} hotSpot @param {string} name @returns {AwtCursor} */
    createCustomCursor(image, hotSpot, name) { return new AwtCursor(); }
}

class MediaTracker {
    /** @private @type {Component} */ component;
    /** @private @type {{image: AwtImage, id: number}[]} */ images = [];

    /** @param {Component} component */
    constructor(component) { this.component = component; }
    
    /** @param {AwtImage} image @param {number} id */
    addImage(image, id) { this.images.push({ image, id }); }
    
    /** @returns {Promise<void>} */
    async waitForAll() { return Promise.resolve(); }
}


// --- Clipboard and Event Queue ---

class AwtTransferable {
    /** @param {any} flavor @returns {any} */
    getTransferData(flavor) { return null; }
}

class AwtClipboard {
    /** @private @type {AwtTransferable | null} */ contents = null;

    /** @param {object} requestor @returns {AwtTransferable} */
    getContents(requestor) { return this.contents || new AwtTransferable(); }
    
    /** @param {AwtTransferable} contents @param {any} owner */
    setContents(contents, owner) { this.contents = contents; }
}

class AwtEventQueue {
    /** @private @type {AwtEvent[]} */ events = [];

    /** @returns {AwtEvent | null} */
    peekEvent() { return this.events.length > 0 ? this.events[0] : null; }
    
    /** @param {AwtEvent} theEvent */
    postEvent(theEvent) { this.events.push(theEvent); }
}


// --- Concrete Implementation Classes ---

/**
 * An implementation of the IGraphics interface using the HTML5 Canvas 2D context.
 * @implements {IGraphics}
 */
class CanvasGraphics {
    /** @private @type {CanvasRenderingContext2D} */ ctx;
    
    /** @param {CanvasRenderingContext2D} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        // Set a default font for the canvas
        this.ctx.font = '12px sans-serif';
    }

    /** @override @param {AwtColor} color */
    setColor(color) {
        const cssColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
        this.ctx.fillStyle = cssColor;
        this.ctx.strokeStyle = cssColor;
    }

    /** @override @param {number} x @param {number} y @param {number} width @param {number} height */
    fillRect(x, y, width, height) { this.ctx.fillRect(x, y, width, height); }

    /** @override @param {number} x @param {number} y @param {number} width @param {number} height */
    drawRect(x, y, width, height) { this.ctx.strokeRect(x, y, width, height); }

    /** @override @param {AwtFont} font */
    setFont(font) {
        const style = font.style === 1 ? 'bold' : font.style === 2 ? 'italic' : 'normal';
        this.ctx.font = `${style} ${font.size}px ${font.name}`;
    }

    /** @override @param {string} str @param {number} x @param {number} y */
    drawString(str, x, y) {
        console.log(`🎨 CanvasGraphics.drawString called: "${str}" at (${x}, ${y})`);
        console.log(`📋 Canvas context:`, this.ctx);
        console.log(`📏 Canvas dimensions:`, this.ctx.canvas ? `${this.ctx.canvas.width}x${this.ctx.canvas.height}` : 'No canvas');

        if (this.ctx && this.ctx.fillText) {
            console.log(`✅ Calling ctx.fillText("${str}", ${x}, ${y})`);
            this.ctx.fillText(str, x, y);
            console.log(`✅ Canvas fillText completed`);
        } else {
            console.log(`❌ No canvas context or fillText method available`);
        }
    }

    /** @override @param {AwtImage} image @param {number} x @param {number} y */
    drawImage(image, x, y) {
        if (image instanceof CanvasImage) {
            this.ctx.drawImage(image.getCanvasElement(), x, y);
            return true;
        }
        return false;
    }

    /** @override @returns {AwtRectangle} */
    getClipBounds() {
        return { x: 0, y: 0, width: this.ctx.canvas.width, height: this.ctx.canvas.height };
    }

    /** @override */
    dispose() { /* No-op */ }
}

/**
 * An implementation of the AwtImage interface using an offscreen HTMLCanvasElement.
 * @implements {AwtImage}
 */
class CanvasImage {
    /** @private @type {HTMLCanvasElement} */ canvas;
    /** @private @type {IGraphics} */ graphics;

    /** @param {number} width @param {number} height */
    constructor(width, height) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;
        const ctx = this.canvas.getContext('2d');
        if (!ctx) throw new Error("Could not create 2D context for CanvasImage");
        this.graphics = new CanvasGraphics(ctx);
    }
    
    /** @override @returns {IGraphics} */
    getGraphics() { return this.graphics; }
    
    /** @override @returns {number} */
    getWidth() { return this.canvas.width; }
    
    /** @override @returns {number} */
    getHeight() { return this.canvas.height; }
    
    /** @returns {HTMLCanvasElement} */
    getCanvasElement() { return this.canvas; }
}

/**
 * Mock implementation for CLI testing
 * @implements {IGraphics}
 */
class MockGraphics {
    /** @private @type {number} */ width;
    /** @private @type {number} */ height;
    /** @private @type {AwtColor} */ currentColor;
    /** @private @type {AwtFont} */ currentFont;
    /** @private @type {string[]} */ operations = [];

    /** @param {number} width @param {number} height */
    constructor(width, height) { 
        this.width = width; 
        this.height = height; 
        this.currentColor = { r: 0, g: 0, b: 0 };
        this.currentFont = { name: 'Arial', style: 0, size: 12 };
    }

    /** @override @param {AwtColor} color */
    setColor(color) { 
        this.currentColor = color; 
        this.operations.push(`setColor(${color.r}, ${color.g}, ${color.b})`);
    }

    /** @override @param {number} x @param {number} y @param {number} width @param {number} height */
    fillRect(x, y, width, height) { 
        this.operations.push(`fillRect(${x}, ${y}, ${width}, ${height})`);
    }

    /** @override @param {number} x @param {number} y @param {number} width @param {number} height */
    drawRect(x, y, width, height) { 
        this.operations.push(`drawRect(${x}, ${y}, ${width}, ${height})`);
    }

    /** @override @param {AwtFont} font */
    setFont(font) { 
        this.currentFont = font; 
        this.operations.push(`setFont(${font.name}, ${font.style}, ${font.size})`);
    }

    /** @override @param {string} str @param {number} x @param {number} y */
    drawString(str, x, y) { 
        this.operations.push(`drawString("${str}", ${x}, ${y})`);
    }

    /** @override @param {AwtImage} image @param {number} x @param {number} y */
    drawImage(image, x, y) {
        this.operations.push(`drawImage(${image.getWidth()}x${image.getHeight()}, ${x}, ${y})`);
        return true;
    }

    /** @override @returns {AwtRectangle} */
    getClipBounds() {
        return { x: 0, y: 0, width: this.width, height: this.height };
    }

    /** @override */
    dispose() { 
        this.operations.push('dispose()');
    }
    
    /** @returns {string[]} */
    getOperations() { return [...this.operations]; }
    
    clearOperations() { this.operations = []; }
}

/**
 * Mock image implementation for CLI testing
 * @implements {AwtImage}
 */
class MockImage {
    /** @private @type {number} */ width;
    /** @private @type {number} */ height;
    /** @private @type {IGraphics} */ graphics;

    /** @param {number} width @param {number} height */
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.graphics = new MockGraphics(width, height);
    }
    
    /** @override @returns {IGraphics} */
    getGraphics() { return this.graphics; }
    
    /** @override @returns {number} */
    getWidth() { return this.width; }
    
    /** @override @returns {number} */
    getHeight() { return this.height; }
}

// Export all classes for module usage
const awtModules = {
    // Event classes
    AwtEvent,
    AwtMouseEvent,
    AwtKeyEvent,
    AwtMouseWheelEvent,
    AwtFocusEvent,
    AwtActionEvent,
    
    // Component classes
    Component,
    Container,
    Canvas,
    Window,
    Frame,
    
    // Toolkit classes
    AwtToolkit,
    MediaTracker,
    AwtClipboard,
    AwtTransferable,
    AwtEventQueue,
    AwtCursor,
    
    // Image classes
    AwtImage,
    CanvasImage: typeof document !== 'undefined' ? CanvasImage : MockImage,
    
    // Graphics classes
    IGraphics,
    CanvasGraphics: typeof document !== 'undefined' ? CanvasGraphics : MockGraphics,
    
    // Mock classes for CLI testing
    MockGraphics,
    MockImage,
};

// Handle different module systems
if (typeof module !== 'undefined' && module.exports) {
    // CommonJS - this is the primary export mechanism
    module.exports = awtModules;
}