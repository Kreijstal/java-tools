#!/usr/bin/env node

/**
 * Build the static site for GitHub Pages deployment
 * Creates a self-contained web interface for the JVM Debug API using real JVM logic
 */

const fs = require('fs');
const path = require('path');

console.log('🏗️  Building JVM Debug Interface site...');

const distDir = path.join(process.cwd(), 'dist');
const examplesDir = path.join(process.cwd(), 'examples');

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

// Step 1: Verify the browser bundle exists
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
    
    // Remove the old, simulated script block to prevent conflicts
    // Target the specific script block that contains the JVM simulation
    htmlContent = htmlContent.replace(/\s*<script>\s*\/\/ Real JVM debug controller using embedded jvm\.js[\s\S]*?<\/script>/s, '');
    
    // Remove old breakpoint UI elements
    htmlContent = htmlContent.replace(/\s*<input type="number" id="breakpointInput"[^>]*>\s*/g, '');
    htmlContent = htmlContent.replace(/\s*<button onclick="setBreakpoint\(\)">Set Breakpoint<\/button>\s*/g, '');
    
    // Enhance the HTML with real JVM integration
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
    <!-- Include the real JVM debug bundle -->
    <script src="/dist/jvm-debug.js"></script>

    <script>
        // Real JVM integration - override mock functions with real implementations
        let jvmDebug = null;
        
        // Define currentState for UI compatibility
        let currentState = {
            status: 'stopped',
            pc: null,
            stack: [],
            locals: [],
            callDepth: 0,
            method: null,
            breakpoints: [],
            loadedClass: null,
            className: null
        };
        
        // Define log function for UI compatibility
        function log(message, type = 'info') {
            const timestamp = new Date().toLocaleTimeString();
            const output = document.getElementById('output');
            if (output) {
                const logEntry = document.createElement('div');
                logEntry.className = \`log-entry \${type}\`;
                logEntry.innerHTML = \`[\${timestamp}] \${message}\`;
                output.appendChild(logEntry);
                output.scrollTop = output.scrollHeight;
            }
            console.log(\`[\${type.toUpperCase()}] \${message}\`);
        }
        
        // Define updateStatus function for UI compatibility
        function updateStatus(message, type = 'info') {
            const statusDiv = document.getElementById('status');
            if (statusDiv) {
                statusDiv.textContent = message;
                statusDiv.className = \`status \${type}\`;
            }
            log(message, type);
        }
        
        // Define updateState function for UI compatibility
        function updateState(updates) {
            Object.assign(currentState, updates);
            log(\`State updated: \${JSON.stringify(updates)}\`, 'debug');
        }
        
        // Initialize real JVM when page loads
        document.addEventListener('DOMContentLoaded', async function() {
            try {
                log('JVM Debug API Example loaded', 'info');
                log('Starting JVM Debug initialization...', 'info');
                
                // Initialize the real JVM debug engine
                if (typeof window.JVMDebug !== 'undefined' && window.JVMDebug.BrowserJVMDebug) {
                    jvmDebug = new window.JVMDebug.BrowserJVMDebug();
                    
                    try {
                        const response = await fetch('/dist/data.zip');
                        if (response.ok) {
                            const buffer = await response.arrayBuffer();
                            const uint8Array = new Uint8Array(buffer);
                            
                            // Load as JAR archive since data.zip is essentially a zip file
                            const extractedFiles = await jvmDebug.fileProvider.loadJarArchive(uint8Array, 'data.zip');
                            log(\`Data package loaded with \${extractedFiles.length} class files\`, 'info');
                            
                            // Initialize the debug environment
                            await jvmDebug.initialize();
                            log(\`Real JVM Debug initialized with \${extractedFiles.length} sample classes\`, 'success');
                            populateSampleClasses();
                        } else {
                            log('Data package fetch failed, initializing without data', 'warning');
                            await jvmDebug.initialize();
                            log('Real JVM Debug initialized (no data package)', 'info');
                        }
                    } catch (err) {
                        log(\`Data package error: \${err.message}\`, 'warning');
                        await jvmDebug.initialize();
                        log('Real JVM Debug initialized without data package', 'info');
                    }
                    
                    log('Real JVM Debug Interface ready! 🚀', 'success');
                    
                    // Enhance the existing functions with real JVM calls
                    enhanceWithRealJVM();
                    
                    // Initialize ACE editor after JVM is ready
                    setTimeout(initializeEditor, 100);
                } else {
                    log('JVM Debug bundle not available - using mock implementation', 'info');
                }
            } catch (error) {
                log(\`Failed to initialize real JVM: \${error.message}\`, 'error');
            }
        });
        
        function populateSampleClasses() {
            // Add sample class loading functionality
            const controls = document.querySelector('.controls');
            if (controls && jvmDebug) {
                try {
                    const classes = [
                        { filename: 'VerySimple.class', name: 'VerySimple', description: 'Basic arithmetic (3-2=1)' },
                        { filename: 'Hello.class', name: 'Hello', description: 'Hello World program' },
                        { filename: 'Calculator.class', name: 'Calculator', description: 'Calculator operations' }
                    ];
                    
                    const samplesDiv = document.createElement('div');
                    samplesDiv.innerHTML = \`
                        <h4>📚 Sample Classes (\${classes.length} available) - or upload your own .class/.jar files</h4>
                        <select id="sampleClassSelect">
                            <option value="">Select a sample class...</option>
                            \${classes.map(cls => 
                                \`<option value="\${cls.filename}">\${cls.name} - \${cls.description}</option>\`
                            ).join('')}
                        </select>
                        <button onclick="loadSampleClass()">Load Sample</button>
                    \`;
                    controls.appendChild(samplesDiv);
                    
                    // Enable the Start Debugging button now that sample classes are available
                    const debugBtn = document.getElementById('debugBtn');
                    if (debugBtn) {
                        debugBtn.disabled = false;
                        log('Start Debugging button enabled - sample classes ready', 'info');
                    }
                    
                    // Also update the state to indicate we have classes available
                    if (typeof updateState === 'function') {
                        updateState({
                            loadedClass: true,
                            className: 'VerySimple', // Default to first sample class
                            status: 'ready'
                        });
                    }
                } catch (error) {
                    log(\`Failed to populate sample classes: \${error.message}\`, 'error');
                }
            }
        }
        
        function loadSampleClass() {
            const select = document.getElementById('sampleClassSelect');
            const selectedClass = select.value;
            
            if (!selectedClass || !jvmDebug) {
                log('Please select a sample class and ensure JVM is initialized', 'error');
                return;
            }
            
            try {
                log(\`Loading sample class: \${selectedClass}\`, 'info');
                
                const result = jvmDebug.start(selectedClass.replace('.class', ''));
                log(\`Debug session started for \${selectedClass}\`, 'success');
                updateDebugDisplay();
                
                // Update the current state to enable debug buttons
                if (typeof updateState === 'function') {
                    updateState({
                        loadedClass: { name: selectedClass },
                        className: selectedClass.replace('.class', ''),
                        status: 'paused'
                    });
                }
                
                if (typeof updateStatus === 'function') {
                    updateStatus('Debugger started - Real JVM session active', 'success');
                }
                
            } catch (error) {
                log(\`Failed to start debugging \${selectedClass}: \${error.message}\`, 'error');
            }
        }
        
        function enhanceWithRealJVM() {
            // Override step functions with real JVM calls
            if (jvmDebug) {
                // Store original functions if they exist
                const originalStartDebugging = window.startDebugging;
                const originalStepInto = window.stepInto;
                const originalStepOver = window.stepOver;
                const originalStepOut = window.stepOut;
                const originalContinue = window.continue_;
                const originalFinish = window.finish;
                
                // Override startDebugging to work with real JVM and sample classes
                window.startDebugging = function() {
                    try {
                        // If no class is explicitly loaded, try to use the default sample class
                        if (!currentState.loadedClass) {
                            log('No class explicitly loaded, starting with default sample class: VerySimple', 'info');
                            const result = jvmDebug.start('VerySimple');
                            updateDebugDisplay();
                            return;
                        }
                        
                        // Use the original logic for explicitly loaded classes
                        if (originalStartDebugging) {
                            originalStartDebugging();
                        } else {
                            // Fallback: start with current state's class name
                            const className = currentState.className || 'VerySimple';
                            log(\`Starting debug session with \${className}...\`, 'info');
                            const result = jvmDebug.start(className);
                            updateDebugDisplay();
                        }
                        
                        // Ensure buttons are updated after starting debugging
                        if (typeof updateButtons === 'function') {
                            updateButtons();
                        }
                    } catch (error) {
                        log(\`Failed to start debugging: \${error.message}\`, 'error');
                        if (originalStartDebugging) originalStartDebugging();
                    }
                };
                
                // Override with real JVM implementations
                window.stepInto = function() {
                    try {
                        const result = jvmDebug.stepInto();
                        log('Step Into completed', 'info');
                        updateDebugDisplay();
                    } catch (error) {
                        log(\`Step into failed: \${error.message}\`, 'error');
                        if (originalStepInto) originalStepInto();
                    }
                };
                
                window.stepOver = function() {
                    try {
                        const result = jvmDebug.stepOver();
                        log('Step Over completed', 'info');
                        updateDebugDisplay();
                    } catch (error) {
                        log(\`Step over failed: \${error.message}\`, 'error');
                        if (originalStepOver) originalStepOver();
                    }
                };
                
                window.stepOut = function() {
                    try {
                        const result = jvmDebug.stepOut();
                        log('Step Out completed', 'info');
                        updateDebugDisplay();
                    } catch (error) {
                        log(\`Step out failed: \${error.message}\`, 'error');
                        if (originalStepOut) originalStepOut();
                    }
                };
                
                window.continue_ = function() {
                    try {
                        const result = jvmDebug.continue();
                        log('Continue completed', 'info');
                        updateDebugDisplay();
                    } catch (error) {
                        log(\`Continue failed: \${error.message}\`, 'error');
                        if (originalContinue) originalContinue();
                    }
                };
                
                window.finish = function() {
                    try {
                        const result = jvmDebug.finish();
                        log('Finish completed', 'info');
                        updateDebugDisplay();
                    } catch (error) {
                        log(\`Finish failed: \${error.message}\`, 'error');
                        if (originalFinish) originalFinish();
                    }
                };
                
                // Add stepInstruction function if it doesn't exist
                if (!window.stepInstruction) {
                    window.stepInstruction = function() {
                        try {
                            const result = jvmDebug.stepInstruction();
                            log('Step Instruction completed', 'info');
                            updateDebugDisplay();
                        } catch (error) {
                            log(\`Step instruction failed: \${error.message}\`, 'error');
                        }
                    };
                }
                
                // Override serialize/deserialize with real JVM state
                const originalSerialize = window.serializeState;
                window.serializeState = function() {
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
                        
                        log('State serialized successfully', 'success');
                    } catch (error) {
                        log(\`State serialization failed: \${error.message}\`, 'error');
                        if (originalSerialize) originalSerialize();
                    }
                };
            }
        }
        
        function updateDebugDisplay() {
            if (!jvmDebug) return;
            
            try {
                const state = jvmDebug.getCurrentState();
                
                // Update execution state display
                const statusDiv = document.getElementById('executionState');
                if (statusDiv) {
                    statusDiv.innerHTML = \`
                        <div><span class="key">Status:</span> <span class="value">\${state.executionState}</span></div>
                        <div><span class="key">PC:</span> <span class="value">\${state.pc !== null ? state.pc : 'N/A'}</span></div>
                        <div><span class="key">Method:</span> <span class="value">\${state.method ? state.method.name : 'N/A'}</span></div>
                        <div><span class="key">Call Depth:</span> <span class="value">\${state.callStackDepth}</span></div>
                        <div><span class="key">Breakpoints:</span> <span class="value">[\${state.breakpoints.join(', ')}]</span></div>
                    \`;
                }
                
                // Update stack display
                const stackDiv = document.getElementById('stackDisplay');
                if (stackDiv) {
                    const stackDisplay = state.stack.map((value, index) => 
                        \`\${index}: \${typeof value === 'string' ? '"\${value}"' : value}\`
                    ).join('\\n') || 'Empty';
                    stackDiv.textContent = stackDisplay;
                }
                
                // Update locals display
                const localsDiv = document.getElementById('localsDisplay');
                if (localsDiv) {
                    const localsDisplay = state.locals.map((value, index) => 
                        \`local_\${index}: \${value !== undefined && value !== null ? 
                            (typeof value === 'string' ? '"\${value}"' : value) : 'undefined'}\`
                    ).join('\\n') || 'No locals';
                    localsDiv.textContent = localsDisplay;
                }
                
                // Update disassembly view
                if (state.executionState === 'paused' || state.executionState === 'running') {
                    try {
                        const view = jvmDebug.getDisassemblyView();
                        if (view && view.formattedDisassembly && window.aceEditor) {
                            aceEditor.setValue(view.formattedDisassembly, -1);
                            
                            // Highlight current line if available
                            if (view.currentLineNumber !== undefined && view.currentLineNumber >= 0) {
                                aceEditor.scrollToLine(view.currentLineNumber, true, true);
                            }
                        }
                    } catch (disasmError) {
                        log(\`Failed to update disassembly: \${disasmError.message}\`, 'error');
                    }
                }
                
                // Update button states
                if (typeof updateButtons === 'function') {
                    const isPaused = state.executionState === 'paused';
                    const stepButtons = ['stepIntoBtn', 'stepOverBtn', 'stepOutBtn', 'stepInstructionBtn', 'continueBtn', 'finishBtn'];
                    stepButtons.forEach(id => {
                        const btn = document.getElementById(id);
                        if (btn) btn.disabled = !isPaused;
                    });
                }
                
            } catch (error) {
                log(\`Failed to update debug display: \${error.message}\`, 'error');
            }
        }
        
        // Add missing clearOutput function 
        function clearOutput() {
            const output = document.getElementById('output');
            if (output) {
                output.innerHTML = '';
                if (typeof log === 'function') {
                    log('Output console cleared.', 'info');
                }
            }
        }
        
        // Enhanced deserializeState function
        function deserializeState() {
            const input = document.getElementById('stateFileInput');
            if (input) {
                input.click();
            }
        }
        
        
        // Enhanced loadClassFile function to handle both .class and .jar files
        const originalLoadClassFile = window.loadClassFile;
        window.loadClassFile = function() {
            const fileInput = document.getElementById('classFileInput');
            const file = fileInput.files[0];
            
            if (!file) {
                log('Please select a file to upload', 'error');
                return;
            }
            
            if (!jvmDebug) {
                log('JVM Debug not initialized', 'error');
                return;
            }
            
            const fileName = file.name;
            const isJar = fileName.toLowerCase().endsWith('.jar');
            const isClass = fileName.toLowerCase().endsWith('.class');
            
            if (!isJar && !isClass) {
                log('Please select a .class or .jar file', 'error');
                return;
            }
            
            log(\`Loading \${isJar ? 'JAR' : 'class'} file: \${fileName}...\`, 'info');
            
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const buffer = new Uint8Array(e.target.result);
                    
                    if (isJar) {
                        // Handle JAR file
                        jvmDebug.loadJar(buffer, fileName);
                        log(\`JAR file \${fileName} loaded successfully\`, 'success');
                    } else {
                        // Handle .class file
                        const className = fileName.replace('.class', '');
                        jvmDebug.loadClass(buffer, className);
                        log(\`Class file \${className} loaded successfully\`, 'success');
                        
                        // Update state to reflect loaded class
                        if (typeof updateState === 'function') {
                            updateState({
                                loadedClass: true,
                                className: className,
                                status: 'ready'
                            });
                        }
                    }
                    
                    // Enable debug button
                    const debugBtn = document.getElementById('debugBtn');
                    if (debugBtn) {
                        debugBtn.disabled = false;
                        log('Start Debugging button enabled', 'info');
                    }
                    
                } catch (error) {
                    log(\`Failed to load \${fileName}: \${error.message}\`, 'error');
                    if (originalLoadClassFile) {
                        originalLoadClassFile();
                    }
                }
            };
            
            reader.onerror = function() {
                log(\`Failed to read file \${fileName}\`, 'error');
            };
            
            reader.readAsArrayBuffer(file);
        };
        
        // Add missing updateButtons function for UI compatibility
        function updateButtons() {
            if (!jvmDebug) {
                // If JVM not initialized, keep debug button enabled but step buttons disabled
                const debugBtn = document.getElementById('debugBtn');
                if (debugBtn) debugBtn.disabled = false;
                
                const stepButtons = ['stepIntoBtn', 'stepOverBtn', 'stepOutBtn', 'stepInstructionBtn', 'continueBtn', 'finishBtn'];
                stepButtons.forEach(id => {
                    const btn = document.getElementById(id);
                    if (btn) btn.disabled = true;
                });
                return;
            }
            
            try {
                const state = jvmDebug.getCurrentState();
                const isPaused = state.executionState === 'paused';
                const isRunning = state.executionState === 'running';
                const hasLoadedClass = currentState.loadedClass !== null || state.method !== null;
                
                // Debug button should be enabled when we have a class and not currently debugging
                const debugBtn = document.getElementById('debugBtn');
                if (debugBtn) {
                    debugBtn.disabled = !hasLoadedClass || isPaused || isRunning;
                }
                
                // Step buttons should be enabled only when paused
                const stepButtons = ['stepIntoBtn', 'stepOverBtn', 'stepOutBtn', 'stepInstructionBtn', 'continueBtn', 'finishBtn'];
                stepButtons.forEach(id => {
                    const btn = document.getElementById(id);
                    if (btn) btn.disabled = !isPaused;
                });
                
            } catch (error) {
                log(\`Error updating buttons: \${error.message}\`, 'error');
            }
        }
        
        // Add missing initializeEditor function for ACE editor setup
        let aceEditor = null;
        function initializeEditor() {
            try {
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

                aceEditor.setValue('Load a class to see disassembly...', -1);
                
                // Add gutter click handler for breakpoints
                aceEditor.on("guttermousedown", function(e) {
                    const target = e.domEvent.target;
                    if (target.className.indexOf("ace_gutter-cell") == -1) return;
                    if (!e.editor.isFocused()) return;
                    if (e.clientX > 25 + target.getBoundingClientRect().left) return;

                    const line = e.getDocumentPosition().row;
                    if (jvmDebug && typeof jvmDebug.getDisassemblyView === 'function') {
                        try {
                            const view = jvmDebug.getDisassemblyView();
                            if (view && view.lineToPcMap && view.lineToPcMap[line] !== undefined) {
                                const pc = view.lineToPcMap[line];
                                const breakpoints = jvmDebug.getBreakpoints();
                                
                                if (breakpoints.includes(pc)) {
                                    jvmDebug.removeBreakpoint(pc);
                                    aceEditor.session.clearBreakpoint(line);
                                    log(\`Breakpoint removed at PC \${pc}\`, 'info');
                                } else {
                                    jvmDebug.setBreakpoint(pc);
                                    aceEditor.session.setBreakpoint(line, "ace_breakpoint");
                                    log(\`Breakpoint set at PC \${pc}\`, 'info');
                                }
                                updateDebugDisplay();
                            }
                        } catch (error) {
                            log(\`Error toggling breakpoint: \${error.message}\`, 'error');
                        }
                    }
                    e.stop();
                });
                
            } catch (e) {
                log(\`ACE editor failed to load: \${e.message}\`, 'warning');
                // Fallback if Ace editor fails to load
                const editorDiv = document.getElementById('disassembly-editor');
                if (editorDiv) {
                    editorDiv.innerHTML = 
                        '<textarea readonly style="width: 100%; height: 300px; background: #1e1e1e; color: #d4d4d4; border: 1px solid #3e3e42;">Load a class to see disassembly...</textarea>';
                }
            }
        }
        
        // Add setBreakpoint function for test compatibility
        function setBreakpoint() {
            const input = document.getElementById('breakpointInput');
            const pc = parseInt(input.value);
            
            if (!jvmDebug) {
                log('JVM Debug not initialized', 'error');
                return;
            }
            
            if (isNaN(pc) || pc < 0) {
                log('Please enter a valid program counter (PC) value', 'error');
                return;
            }
            
            try {
                jvmDebug.setBreakpoint(pc);
                log(\`Breakpoint set at PC \${pc}\`, 'success');
                input.value = '';
                updateDebugDisplay();
            } catch (error) {
                log(\`Failed to set breakpoint: \${error.message}\`, 'error');
            }
        }
        
        // Add clearAllBreakpoints function implementation
        function clearAllBreakpoints() {
            if (!jvmDebug) {
                log('JVM Debug not initialized', 'error');
                return;
            }
            
            try {
                jvmDebug.clearBreakpoints();
                log('All breakpoints cleared', 'success');
                
                // Clear visual breakpoints from editor
                if (aceEditor && aceEditor.session) {
                    aceEditor.session.clearBreakpoints();
                }
                
                updateDebugDisplay();
            } catch (error) {
                log(\`Failed to clear breakpoints: \${error.message}\`, 'error');
            }
        }
    </script>
    `;
    
    // Add breakpoint input UI for test compatibility (add after clear breakpoints button)
    const clearBreakpointsPattern = /(<button onclick="clearAllBreakpoints\(\)">Clear All Breakpoints<\/button>)/;
    htmlContent = htmlContent.replace(clearBreakpointsPattern, 
        '<input type="number" id="breakpointInput" class="breakpoint-input" placeholder="PC" title="Program Counter for breakpoint">\n            <button onclick="setBreakpoint()">Set Breakpoint</button>\n            $1');
    
    // Add the missing stepInstruction button to the debug controls
    const debugControlsPattern = /(<button onclick="finish\(\)" id="finishBtn"[^>]*>⏩<\/button>)/;
    htmlContent = htmlContent.replace(debugControlsPattern, '$1\n            <button onclick="stepInstruction()" id="stepInstructionBtn" title="Step Instruction" disabled>📶</button>');
    
    // Add the deserializeBtn ID to the restore state button and add text
    const restoreButtonPattern = /(<button onclick="document\.getElementById\('stateFileInput'\)\.click\(\)"[^>]*>📂<\/button>)/;
    htmlContent = htmlContent.replace(restoreButtonPattern, '<button onclick="deserializeState()" id="deserializeBtn" title="Restore State">📂 Restore State</button>');
    
    // Add ID and text to the serialize button for test compatibility
    const serializeButtonPattern = /(<button onclick="serializeState\(\)" title="Serialize State">💾<\/button>)/;
    htmlContent = htmlContent.replace(serializeButtonPattern, '<button onclick="serializeState()" id="serializeBtn" title="Serialize State">💾 Serialize State</button>');
    
    // Add the Clear button to the output console
    const outputConsolePattern = /(<h3>Output Console<\/h3>)/;
    htmlContent = htmlContent.replace(outputConsolePattern, '$1\n                <button onclick="clearOutput()" style="float: right; font-size: 10px; padding: 2px 6px;">Clear</button>');
    
    // Add stepInstruction button to the original updateButtons function
    const updateButtonsPattern = /(document\.getElementById\('finishBtn'\)\.disabled = !isPaused;)/;
    htmlContent = htmlContent.replace(updateButtonsPattern, '$1\n            document.getElementById(\'stepInstructionBtn\').disabled = !isPaused;');
    
    // Consolidate upload mechanisms - update file input to accept both .class and .jar files
    const fileInputPattern = /(<input type="file" id="classFileInput" accept="\.class"[^>]*>)/;
    htmlContent = htmlContent.replace(fileInputPattern, '<input type="file" id="classFileInput" accept=".class,.jar" style="margin-right: 10px;" title="Upload .class or .jar files">');
    
    // Update the load button text to reflect unified functionality
    const loadButtonPattern = /(<button onclick="loadClassFile\(\)" id="loadBtn">)Load Class(<\/button>)/;
    htmlContent = htmlContent.replace(loadButtonPattern, '$1Upload Custom File$2');
    
    // Insert enhancements before the closing </head> tag
    return htmlContent.replace('</head>', enhancements + '</head>');
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