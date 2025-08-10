#!/usr/bin/env node

/**
 * Build the static site for GitHub Pages deployment
 * Creates a self-contained web interface for the JVM Debug API using real JVM logic
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🏗️  Building JVM Debug Interface site...');

const distDir = path.join(process.cwd(), 'dist');
const examplesDir = path.join(process.cwd(), 'examples');

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

// Step 1: Verify the browser bundle exists (should be built by npm run build:bundle)
console.log('📦 Verifying browser bundle exists...');
const bundlePath = path.join(distDir, 'jvm-debug.js');
if (!fs.existsSync(bundlePath)) {
    console.error('❌ Bundle not found! Run npm run build:bundle first');
    process.exit(1);
}
console.log('  ✓ Bundle found successfully');

// Step 2: Copy and enhance the debug web interface
console.log('📄 Creating enhanced debug interface...');
const debugInterfacePath = path.join(examplesDir, 'debug-web-interface.html');
const indexPath = path.join(distDir, 'index.html');

if (fs.existsSync(debugInterfacePath)) {
    let htmlContent = fs.readFileSync(debugInterfacePath, 'utf8');
    
    // Update the HTML to use the real JVM bundle
    htmlContent = enhanceDebugInterfaceWithRealJVM(htmlContent);
    
    fs.writeFileSync(indexPath, htmlContent);
    console.log('  ✓ index.html created with real JVM integration');
} else {
    console.error('❌ Debug web interface not found!');
    process.exit(1);
}

// Step 3: Create README for the GitHub Pages site
console.log('📝 Creating site README...');
const readmePath = path.join(distDir, 'README.md');
fs.writeFileSync(readmePath, createSiteReadme());

console.log('✅ Site build complete!');
console.log(`🌐 Ready for deployment to GitHub Pages`);
console.log('📦 Real JVM debug logic is now available in the browser!');

function enhanceDebugInterfaceWithRealJVM(htmlContent) {
    // Add GitHub Pages specific enhancements and real JVM integration
    const enhancements = `
    <!-- Include Ace Editor from CDN -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/ace/1.15.2/ace.js"></script>
    
    <!-- Include the real JVM debug bundle -->
    <script src="./jvm-debug.js"></script>

    <!-- Enhanced Styles for the new IDE layout -->
    <style>
        .main-container { 
            display: grid; 
            grid-template-columns: 2fr 1fr; 
            gap: 20px; 
            margin-top: 20px;
        }
        .debugger-panel { 
            display: flex; 
            flex-direction: column; 
            gap: 10px; 
        }
        .state-panel-stack { 
            display: flex; 
            flex-direction: column; 
            gap: 20px; 
        }
        #disassembly-editor { 
            width: 100%; 
            height: 60vh; 
            border: 1px solid #3e3e42; 
            border-radius: 5px; 
        }
        .debug-controls { 
            display: flex; 
            gap: 8px; 
            margin-bottom: 10px; 
            flex-wrap: wrap;
            align-items: center;
        }
        .debug-controls button { 
            font-size: 1.2em; 
            padding: 8px 12px; 
            min-width: 40px;
            background-color: #0e639c;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        }
        .debug-controls button:hover {
            background-color: #1177bb;
        }
        .debug-controls button:disabled {
            background-color: #3e3e42;
            cursor: not-allowed;
        }
        .ace_gutter-cell.ace_breakpoint { 
            background-color: #f44336 !important; 
            border-radius: 50%; 
        }
        .ace-editor-highlight { 
            position: absolute; 
            background: rgba(86, 156, 214, 0.3); 
            z-index: 20; 
        }
        .state-display {
            background-color: #1e1e1e;
            border: 1px solid #3e3e42;
            padding: 10px;
            border-radius: 3px;
            max-height: 200px;
            overflow-y: auto;
            font-size: 12px;
            white-space: pre-wrap;
        }
    </style>

    <!-- Real JVM Debug Integration -->
    <script>
        // Real JVM Debug implementation using the actual JVM logic
        let jvmDebug = null;
        let lineToPcMap = {};
        
        // Add log function that works even if JVM isn't initialized
        function log(message, type = 'info') {
            const output = document.getElementById('output');
            if (output) {
                const timestamp = new Date().toLocaleTimeString();
                const className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
                output.innerHTML += \`<div class="\${className}">[\${timestamp}] \${message}</div>\`;
                output.scrollTop = output.scrollHeight;
            } else {
                console.log(\`[\${type.toUpperCase()}] \${message}\`);
            }
        }
        
        // Initialize the real JVM debug interface
        async function initializeRealJVM() {
            try {
                jvmDebug = new JVMDebug.BrowserJVMDebug();
                
                // Load data package if available
                try {
                    const response = await fetch('./data/metadata.json');
                    if (response.ok) {
                        const metadata = await response.json();
                        
                        // Load actual class files by fetching them from the data directory
                        const dataPackage = { classes: [] };
                        
                        log('Loading class files from data directory...', 'info');
                        for (const classInfo of metadata.classes) {
                            try {
                                const classResponse = await fetch(\`./data/\${classInfo.filename}\`);
                                if (classResponse.ok) {
                                    const arrayBuffer = await classResponse.arrayBuffer();
                                    const content = new Uint8Array(arrayBuffer);
                                    
                                    // Convert to base64 for compatibility with loadDataPackage
                                    let base64String = '';
                                    const chunkSize = 8192;
                                    for (let i = 0; i < content.length; i += chunkSize) {
                                        const chunk = content.slice(i, i + chunkSize);
                                        base64String += String.fromCharCode.apply(null, chunk);
                                    }
                                    
                                    dataPackage.classes.push({
                                        name: classInfo.name,
                                        filename: classInfo.filename,
                                        size: classInfo.size,
                                        description: classInfo.description,
                                        content: btoa(base64String)
                                    });
                                    log(\`Loaded \${classInfo.filename} (\${classInfo.size} bytes)\`, 'info');
                                } else {
                                    log(\`Failed to fetch \${classInfo.filename}: \${classResponse.status}\`, 'error');
                                }
                            } catch (fileError) {
                                log(\`Error loading \${classInfo.filename}: \${fileError.message}\`, 'error');
                            }
                        }
                        
                        await jvmDebug.initialize({ dataPackage });
                        log(\`Initialized with \${dataPackage.classes.length} classes loaded\`, 'success');
                        populateSampleClasses(dataPackage.classes);
                    } else {
                        await jvmDebug.initialize();
                        log('JVM Debug initialized (no data package)', 'info');
                    }
                } catch (err) {
                    await jvmDebug.initialize();
                    log('JVM Debug initialized without data package', 'info');
                }
                
                return true;
            } catch (error) {
                console.error('Failed to initialize JVM Debug:', error);
                log(\`Failed to initialize JVM: \${error.message}\`, 'error');
                return false;
            }
        }

        // Initialize Ace Editor
        function initializeEditor() {
            try {
                if (typeof ace !== 'undefined') {
                    aceEditor = ace.edit("disassembly-editor");
                    aceEditor.setTheme("ace/theme/monokai");
                    aceEditor.session.setMode("ace/mode/text");
                    aceEditor.setReadOnly(true);
                    aceEditor.renderer.setShowGutter(true);
                    aceEditor.renderer.setPadding(10);
                    aceEditor.setOptions({ 
                        highlightActiveLine: false, 
                        highlightGutterLine: false,
                        fontSize: 12
                    });

                    // Gutter click handler for breakpoints
                    aceEditor.on("guttermousedown", function(e) {
                        const line = e.getDocumentPosition().row;
                        const pc = lineToPcMap[line];
                        
                        if (pc === undefined) return;

                        try {
                            const breakpoints = jvmDebug.getBreakpoints();
                            if (breakpoints.includes(pc)) {
                                jvmDebug.removeBreakpoint(pc);
                                aceEditor.session.clearBreakpoint(line);
                                log(\`Breakpoint removed at PC \${pc}\`, 'info');
                            } else {
                                jvmDebug.setBreakpoint(pc);
                                aceEditor.session.setBreakpoint(line, "ace_breakpoint");
                                log(\`Breakpoint set at PC \${pc}\`, 'success');
                            }
                            updateDebugDisplay(); // Refresh state
                        } catch (error) {
                            log(\`Breakpoint operation failed: \${error.message}\`, 'error');
                        }
                    });

                    aceEditor.setValue('Load a class to see disassembly...', -1);
                    log('Ace Editor initialized successfully', 'success');
                } else {
                    // Fallback when Ace Editor is not available
                    const editorElement = document.getElementById('disassembly-editor');
                    if (editorElement) {
                        editorElement.innerHTML = \`
                            <div style="background: #1e1e1e; color: #d4d4d4; padding: 15px; font-family: monospace; height: 100%; overflow-y: auto; border: 1px solid #3e3e42; border-radius: 3px;">
                                <div style="color: #f44747; margin-bottom: 10px;">⚠️ Code editor not available (CDN blocked)</div>
                                <div id="disassembly-text" style="white-space: pre-wrap;">Load a class to see disassembly...</div>
                            </div>
                        \`;
                    }
                    log('Using fallback text editor (Ace Editor not available)', 'info');
                }
            } catch (error) {
                log(\`Failed to initialize editor: \${error.message}\`, 'error');
                // Create basic fallback
                const editorElement = document.getElementById('disassembly-editor');
                if (editorElement) {
                    editorElement.innerHTML = \`
                        <div style="background: #1e1e1e; color: #d4d4d4; padding: 15px; font-family: monospace; height: 100%; overflow-y: auto; border: 1px solid #3e3e42; border-radius: 3px;">
                            <div id="disassembly-text" style="white-space: pre-wrap;">Editor initialization failed. Load a class to see disassembly...</div>
                        </div>
                    \`;
                }
            }
        }
        
        // Enhanced file upload with real class loading
        function addRealFileUpload() {
            const controls = document.querySelector('.controls');
            const fileUploadDiv = document.createElement('div');
            fileUploadDiv.innerHTML = \`
                <h4>📁 Upload Custom Class File</h4>
                <input type="file" id="classFileInput" accept=".class,.jar" multiple />
                <button onclick="loadCustomFiles()">Load Files</button>
                <input type="file" id="stateFileInput" style="display: none;" accept=".json">
                <div id="uploadStatus" style="margin-top: 10px;"></div>
            \`;
            controls.appendChild(fileUploadDiv);
        }
        
        async function loadCustomFiles() {
            const fileInput = document.getElementById('classFileInput');
            const files = fileInput.files;
            
            if (!files || files.length === 0) {
                updateUploadStatus('Please select .class or .jar files', 'error');
                return;
            }
            
            try {
                for (const file of files) {
                    const result = await jvmDebug.loadFile(file);
                    updateUploadStatus(\`Loaded \${result.fileName} (\${result.size} bytes)\`, 'success');
                    log(\`File loaded: \${result.fileName}\`, 'success');
                }
                
                // Refresh file list
                const files = await jvmDebug.listFiles();
                log(\`Total files available: \${files.length}\`, 'info');
            } catch (error) {
                updateUploadStatus(\`Failed to load files: \${error.message}\`, 'error');
                log(\`File load error: \${error.message}\`, 'error');
            }
        }
        
        function updateUploadStatus(message, type) {
            const status = document.getElementById('uploadStatus');
            if (status) {
                status.textContent = message;
                status.className = type;
            }
        }
        
        // Sample classes integration
        function populateSampleClasses(classes) {
            const controls = document.querySelector('.controls');
            const samplesDiv = document.createElement('div');
            samplesDiv.innerHTML = \`
                <h4>📚 Sample Class Files (\${classes.length} available)</h4>
                <select id="sampleClassSelect">
                    <option value="">Select a sample class...</option>
                    \${classes.map(cls => 
                        \`<option value="\${cls.filename}">\${cls.name} - \${cls.description}</option>\`
                    ).join('')}
                </select>
                <button onclick="loadSampleClass()">Load & Debug</button>
            \`;
            controls.appendChild(samplesDiv);
        }
        
        async function loadSampleClass() {
            const select = document.getElementById('sampleClassSelect');
            const selectedClass = select.value;
            
            if (!selectedClass) {
                log('Please select a sample class', 'error');
                return;
            }
            
            try {
                log(\`Loading sample class: \${selectedClass}\`, 'info');
                
                // Set the loaded class state before starting debug session
                updateState({ 
                    loadedClass: { name: selectedClass },
                    className: selectedClass
                });
                
                const result = await jvmDebug.start(selectedClass);
                log(\`Debug session started for \${selectedClass}\`, 'success');
                log(\`Status: \${result.status}\`, 'info');
                updateDebugDisplay();
            } catch (error) {
                log(\`Failed to start debugging \${selectedClass}: \${error.message}\`, 'error');
                // Reset loadedClass on failure
                updateState({ 
                    loadedClass: null,
                    className: null
                });
            }
        }
        
        // Real debug functionality
        function startDebugging() {
            log('Use "Load & Debug" button with sample classes or upload your own .class files', 'info');
        }
        
        function stepInto() {
            if (!jvmDebug) {
                log('JVM not initialized', 'error');
                return;
            }
            
            try {
                const result = jvmDebug.stepInto();
                log(\`Step into: \${result.status}\`, 'info');
                updateDebugDisplay();
            } catch (error) {
                log(\`Step into failed: \${error.message}\`, 'error');
            }
        }
        
        function stepOver() {
            if (!jvmDebug) {
                log('JVM not initialized', 'error');
                return;
            }
            
            try {
                const result = jvmDebug.stepOver();
                log(\`Step over: \${result.status}\`, 'info');
                updateDebugDisplay();
            } catch (error) {
                log(\`Step over failed: \${error.message}\`, 'error');
            }
        }
        
        function stepOut() {
            if (!jvmDebug) {
                log('JVM not initialized', 'error');
                return;
            }
            
            try {
                const result = jvmDebug.stepOut();
                log(\`Step out: \${result.status}\`, 'info');
                updateDebugDisplay();
            } catch (error) {
                log(\`Step out failed: \${error.message}\`, 'error');
            }
        }

        function continue_() {
            if (!jvmDebug) {
                log('JVM not initialized', 'error');
                return;
            }
            
            try {
                const result = jvmDebug.continue();
                log(\`Continue: \${result.status}\`, 'info');
                updateDebugDisplay();
            } catch (error) {
                log(\`Continue failed: \${error.message}\`, 'error');
            }
        }

        function finish() {
            if (!jvmDebug) {
                log('JVM not initialized', 'error');
                return;
            }
            
            try {
                const result = jvmDebug.finish();
                log(\`Finish: \${result.status}\`, 'info');
                updateDebugDisplay();
            } catch (error) {
                log(\`Finish failed: \${error.message}\`, 'error');
            }
        }

        function serializeState() {
            if (!jvmDebug) {
                log('JVM not initialized', 'error');
                return;
            }
            
            try {
                const state = jvmDebug.serialize();
                const stateJson = JSON.stringify(state, null, 2);
                const blob = new Blob([stateJson], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = \`jvm-state-\${new Date().toISOString().replace(/[:.]/g, '-')}.json\`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                log(\`State serialized and downloaded (\${stateJson.length} bytes)\`, 'success');
            } catch (error) {
                log(\`State serialization failed: \${error.message}\`, 'error');
            }
        }

        function deserializeState() {
            document.getElementById('stateFileInput').click();
        }

        async function handleStateFile(event) {
            const file = event.target.files[0];
            if (!file) {
                return;
            }

            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const state = JSON.parse(e.target.result);
                    if (!jvmDebug) {
                        await initializeRealJVM();
                    }
                    jvmDebug.deserialize(state);
                    log('State restored successfully from file.', 'success');
                    updateDebugDisplay();
                } catch (error) {
                    log(\`Failed to restore state: \${error.message}\`, 'error');
                }
            };
            reader.readAsText(file);
        }
        
        function setBreakpoint() {
            const pcInput = document.getElementById('pcInput');
            const pc = parseInt(pcInput.value);
            
            if (isNaN(pc)) {
                log('Please enter a valid PC value', 'error');
                return;
            }
            
            if (!jvmDebug) {
                log('JVM not initialized', 'error');
                return;
            }
            
            try {
                const result = jvmDebug.setBreakpoint(pc);
                log(\`Breakpoint set at PC \${pc}\`, 'success');
                updateDebugDisplay();
            } catch (error) {
                log(\`Failed to set breakpoint: \${error.message}\`, 'error');
            }
        }
        
        function clearBreakpoints() {
            if (!jvmDebug) {
                log('JVM not initialized', 'error');
                return;
            }
            
            try {
                const result = jvmDebug.clearBreakpoints();
                log('All breakpoints cleared', 'success');
                updateDebugDisplay();
            } catch (error) {
                log(\`Failed to clear breakpoints: \${error.message}\`, 'error');
            }
        }
        function updateDebugDisplay() {
            if (!jvmDebug) return;

            try {
                const state = jvmDebug.getCurrentState();
                
                // Update currentState to sync with the real JVM state using updateState
                updateState({
                    status: state.executionState,
                    pc: state.pc,
                    stack: state.stack || [],
                    locals: state.locals || [],
                    callDepth: state.callStackDepth || 0,
                    method: state.method ? state.method.name : null,
                    breakpoints: state.breakpoints || []
                });
                
                // Mark as loaded when debugging is active if not already set
                if (!currentState.loadedClass && state.executionState !== 'stopped') {
                    updateState({ loadedClass: { name: 'active' } });
                }
                
                // Update text-based state panels
                const statusDiv = document.getElementById('executionState');
                if (statusDiv) {
                    statusDiv.innerHTML = \`
                        <strong>State:</strong> \${state.executionState}\\n
                        <strong>PC:</strong> \${state.pc !== null ? state.pc : 'N/A'}\\n
                        <strong>Method:</strong> \${state.method ? state.method.name : 'N/A'}\\n
                        <strong>Call Depth:</strong> \${state.callStackDepth}\\n
                        <strong>Breakpoints:</strong> [\${state.breakpoints.join(', ')}]
                    \`;
                }

                const stackDiv = document.getElementById('stackDisplay');
                if (stackDiv) {
                    const stackDisplay = state.stack.map((value, index) => 
                        \`\${index}: \${typeof value === 'string' ? '"\${value}"' : value}\`
                    ).join('\\n') || 'Empty';
                    stackDiv.textContent = stackDisplay;
                }

                const localsDiv = document.getElementById('localsDisplay');
                if (localsDiv) {
                    const localsDisplay = state.locals.map((value, index) => 
                        \`local_\${index}: \${value !== undefined && value !== null ? 
                            (typeof value === 'string' ? '"\${value}"' : value) : 'undefined'}\`
                    ).join('\\n') || 'No locals';
                    localsDiv.textContent = localsDisplay;
                }
                
                // Update the Ace Editor with disassembly
                if ((state.executionState === 'paused' || state.executionState === 'running')) {
                    try {
                        const view = jvmDebug.getDisassemblyView();
                        if (view && view.formattedDisassembly) {
                            if (aceEditor) {
                                // Use Ace Editor if available
                                aceEditor.setValue(view.formattedDisassembly, -1);
                                
                                // Clear previous highlights and breakpoints
                                aceEditor.session.clearBreakpoints();
                                const markers = aceEditor.session.getMarkers();
                                for (const i in markers) {
                                    if (markers[i].clazz === "ace-editor-highlight") {
                                        aceEditor.session.removeMarker(markers[i].id);
                                    }
                                }

                                // Rebuild line-to-pc map
                                lineToPcMap = {};
                                const lines = view.formattedDisassembly.split('\\n');
                                lines.forEach((lineText, index) => {
                                    // Look for PC markers like "L0:", "L3:", etc.
                                    const match = lineText.match(/L(\\d+):/);
                                    if (match) {
                                        lineToPcMap[index] = parseInt(match[1]);
                                    }
                                });

                                // Highlight current line if available
                                if (view.currentLineNumber !== undefined && view.currentLineNumber >= 0) {
                                    const currentLine = view.currentLineNumber;
                                    const Range = ace.require("ace/range").Range;
                                    aceEditor.session.addMarker(new Range(currentLine, 0, currentLine, 1), "ace-editor-highlight", "fullLine");
                                    aceEditor.scrollToLine(currentLine, true, true);
                                }
                                
                                // Redraw breakpoints
                                const breakpoints = state.breakpoints || [];
                                for (const [line, pc] of Object.entries(lineToPcMap)) {
                                    if (breakpoints.includes(pc)) {
                                        aceEditor.session.setBreakpoint(parseInt(line), "ace_breakpoint");
                                    }
                                }
                            } else {
                                // Fallback to simple text display
                                const textElement = document.getElementById('disassembly-text');
                                if (textElement) {
                                    // Add highlighting for current line in fallback mode
                                    let formattedText = view.formattedDisassembly;
                                    if (view.currentLineNumber !== undefined) {
                                        const lines = formattedText.split('\\n');
                                        if (lines[view.currentLineNumber]) {
                                            lines[view.currentLineNumber] = '>>> ' + lines[view.currentLineNumber] + ' <<<';
                                        }
                                        formattedText = lines.join('\\n');
                                    }
                                    textElement.textContent = formattedText;
                                }
                            }
                        }
                    } catch (disasmError) {
                        console.warn('Failed to update disassembly:', disasmError);
                        if (aceEditor) {
                            aceEditor.setValue('Disassembly unavailable: ' + disasmError.message, -1);
                        } else {
                            const textElement = document.getElementById('disassembly-text');
                            if (textElement) {
                                textElement.textContent = 'Disassembly unavailable: ' + disasmError.message;
                            }
                        }
                    }
                } else {
                    if (aceEditor) {
                        aceEditor.setValue('Execution completed or not started.', -1);
                    } else {
                        const textElement = document.getElementById('disassembly-text');
                        if (textElement) {
                            textElement.textContent = 'Execution completed or not started.';
                        }
                    }
                }
            } catch (error) {
                log(\`Failed to update debug display: \${error.message}\`, 'error');
            }
            
            // Update button states to sync with the real JVM state
            updateButtons();
        }
        
        // Initialize everything when page loads
        document.addEventListener('DOMContentLoaded', async function() {
            log('Initializing Real JVM Debug Interface...', 'info');
            
            initializeEditor(); // Initialize Ace Editor first
            const success = await initializeRealJVM();
            if (success) {
                addRealFileUpload();
                // Set up file input event listener
                document.getElementById('stateFileInput').addEventListener('change', handleStateFile, false);
                log('Real JVM Debug Interface ready! 🚀', 'success');
            } else {
                log('Failed to initialize JVM Debug Interface', 'error');
            }
        });
    </script>
    `;
    
    // Now I need to replace the HTML layout with the new IDE-style layout
    let newHtml = htmlContent;

    // Replace the old container and controls structure with new layout
    const oldLayout = /<div class="panel controls">.*?<\/div>\s*<div class="container">.*?<\/div>/s;
    const newLayout = `
    <div class="panel controls">
        <h3>File Operations</h3>
        <div id="status" class="status">Ready - No program loaded</div>
    </div>

    <!-- Main UI Layout with IDE-style interface -->
    <div class="main-container">
        <!-- Left Column: Debugger -->
        <div class="debugger-panel panel">
            <div class="debug-controls">
                <button onclick="continue_()" title="Continue (F8)">▶️</button>
                <button onclick="stepOver()" title="Step Over (F10)">↷</button>
                <button onclick="stepInto()" title="Step Into (F11)">↪️</button>
                <button onclick="stepOut()" title="Step Out (Shift+F11)">↩️</button>
                <button onclick="finish()" title="Finish Method">⏩</button>
                <button onclick="serializeState()" title="Serialize State">💾</button>
                <button onclick="deserializeState()" title="Restore State">📂</button>
            </div>
            <div id="disassembly-editor"></div>
        </div>

        <!-- Right Column: State & Output -->
        <div class="state-panel-stack">
            <div class="panel">
                <h3>Execution State</h3>
                <div id="executionState" class="state-display">Not started</div>
            </div>
            <div class="panel">
                <h3>Stack</h3>
                <div id="stackDisplay" class="state-display">Empty</div>
            </div>
            <div class="panel">
                <h3>Locals</h3>
                <div id="localsDisplay" class="state-display">No locals</div>
            </div>
            <div class="panel">
                <h3>Output Console</h3>
                <div id="output" class="output"></div>
            </div>
        </div>
    </div>
    `;

    newHtml = newHtml.replace(oldLayout, newLayout);
    
    // Insert enhancements before the closing </head> tag
    return newHtml.replace('</head>', enhancements + '</head>');
}

function createSiteReadme() {
    return `# Interactive JVM Debug Interface

**🚀 Now featuring REAL JVM bytecode execution!**

This is a live demonstration of the Java Tools project's comprehensive JVM debugging capabilities, now running actual JVM logic in the browser.

## 🔍 Real Features

- **Real JVM Execution**: Uses the actual JVM implementation, not a simulation
- **Step-by-Step Debugging**: Execute Java bytecode instruction by instruction with full visibility
- **Real-Time State Inspection**: Watch the actual JVM stack, local variables, and program counter
- **File Upload Support**: Upload and debug custom .class files or JAR archives
- **Breakpoint Management**: Set breakpoints at any program counter location
- **State Serialization**: Pause and resume actual JVM execution across sessions
- **Cross-Platform**: Same JVM logic that runs in Node.js, now in your browser

## 🛠️ How It Works

This interface uses:
- **Webpack bundling** to make Node.js JVM code browser-compatible
- **FileProvider abstraction** for platform-agnostic file operations  
- **Real JVM classes**: \`JVM\`, \`DebugController\`, and all core logic
- **JSZip integration** for JAR file support in the browser

## 🚀 Usage

1. Wait for "Real JVM Debug Interface ready! 🚀" message
2. Select a sample class from the dropdown and click "Load & Debug"
3. Use step controls to execute bytecode instructions one by one
4. Upload your own .class or .jar files for custom debugging
5. Set breakpoints and inspect real JVM state

## 📚 Sample Classes

The interface includes pre-loaded sample classes demonstrating JVM features:

- **Hello**: Simple Hello World program
- **VerySimple**: Basic arithmetic (3-2=1)  
- **RuntimeArithmetic**: Comprehensive arithmetic operations
- **Calculator**: Static method calls with parameters
- **StringConcatMethod**: String concatenation examples
- **ConstantsTest**: Integer constant instructions

## 🔧 Technical Architecture

### Isomorphic Design
- Core JVM logic works in both Node.js and browser
- FileProvider pattern abstracts file system operations
- Webpack creates browser-compatible bundle

### Real vs Mock
- ❌ Previous version: Separate mock implementation 
- ✅ Current version: Real JVM logic bundled for browser

### Browser Compatibility
- Real bytecode parsing and execution
- Actual debug state serialization
- True-to-life JVM behavior

## 📖 More Information

- [GitHub Repository](https://github.com/Kreijstal/java-tools)
- [Debug API Documentation](https://github.com/Kreijstal/java-tools/blob/master/DEBUG_API.md)
- [Project README](https://github.com/Kreijstal/java-tools/blob/master/README.md)

---

**Built with real JVM implementation - same code that powers the Node.js version!**
`;
}