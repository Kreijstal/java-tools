/**
 * Browser UI Enhancement Module for JVM Debug Interface
 * 
 * This module provides the browser-specific UI functionality for the JVM debug interface.
 * Previously this was hardcoded as a massive string injection in buildSite.js.
 */

// Constants for commonly used DOM element IDs
const DOM_IDS = {
    DEBUG_BTN: 'debugBtn',
    SAMPLE_CLASS_SELECT: 'sampleClassSelect',
    DISASSEMBLY_EDITOR: 'disassembly-editor',
    STATE_FILE_INPUT: 'stateFileInput',
    OUTPUT: 'output',
    STATUS: 'status',
    STACK_DISPLAY: 'stackDisplay',
    LOCALS_DISPLAY: 'localsDisplay',
    EXECUTION_STATE: 'executionState',
    CLASS_FILE_INPUT: 'classFileInput',
    BREAKPOINT_INPUT: 'breakpointInput'
};

// Constants for step button IDs
const STEP_BUTTON_IDS = [
    'stepIntoBtn', 
    'stepOverBtn', 
    'stepOutBtn', 
    'stepInstructionBtn', 
    'continueBtn', 
    'finishBtn'
];

// Global state for UI compatibility
let jvmDebug = null;
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

// ACE Editor instance
let aceEditor = null;

// Utility Functions
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const output = document.getElementById(DOM_IDS.OUTPUT);
    if (output) {
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.innerHTML = `[${timestamp}] ${message}`;
        output.appendChild(logEntry);
        output.scrollTop = output.scrollHeight;
    }
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// Helper function to log errors consistently
function logError(message, error) {
    log(`${message}: ${error.message}`, 'error');
}

function updateStatus(message, type = 'info') {
    const statusDiv = document.getElementById(DOM_IDS.STATUS);
    if (statusDiv) {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
    }
    log(message, type);
}

function updateState(updates) {
    Object.assign(currentState, updates);
    // Reduced verbosity: Only log important state changes, not all debug updates
    if (updates.status && (updates.status === 'paused' || updates.status === 'stopped' || updates.status === 'ready')) {
        log(`State: ${updates.status}`, 'debug');
    }
}

function updateButtons() {
    if (!jvmDebug) {
        // If JVM not initialized, keep debug button enabled but step buttons disabled
        const debugBtn = document.getElementById(DOM_IDS.DEBUG_BTN);
        if (debugBtn) debugBtn.disabled = false;
        
        STEP_BUTTON_IDS.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = true;
        });
        return;
    }
    
    if (!jvmDebug) {
        log('JVM not initialized - cannot update button states', 'error');
        return;
    }
    
    const state = jvmDebug.getCurrentState();
    const isPaused = state.executionState === 'paused';
    const isRunning = state.executionState === 'running';
    const hasLoadedClass = currentState.loadedClass !== null || state.method !== null;
    
    // Debug button should be enabled when we have a class and not currently debugging
    const debugBtn = document.getElementById(DOM_IDS.DEBUG_BTN);
    if (debugBtn) {
        debugBtn.disabled = !hasLoadedClass || isPaused || isRunning;
    }
    
    // Step buttons should be enabled only when paused
    STEP_BUTTON_IDS.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = !isPaused;
    });
    
    // Reduced verbosity: Only log button state changes in verbose mode
    // log(`Debug buttons ${isPaused ? 'enabled' : 'disabled'}`, 'debug');
}



// JVM Integration Functions
function setupStateFileInput() {
    // Set up state file input handler
    const stateFileInput = document.getElementById(DOM_IDS.STATE_FILE_INPUT);
    if (stateFileInput) {
        stateFileInput.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const serializedState = JSON.parse(e.target.result);
                    
                    // Try to restore using the real JVM
                    if (jvmDebug && typeof jvmDebug.deserialize === 'function') {
                        jvmDebug.deserialize(serializedState);
                        updateDebugDisplay();
                        updateStatus('State restored successfully', 'success');
                        log('JVM state restored successfully', 'success');
                        
                        if (serializedState.loadedClass) {
                            log(`Restored class: ${serializedState.loadedClass.name}`, 'success');
                        }
                    } else {
                        throw new Error('JVM not initialized - cannot restore state');
                    }
                } catch (error) {
                    logError('Failed to restore state', error);
                    updateStatus('Failed to restore state', 'error');
                }
            };
            reader.readAsText(file);
        });
    }
}

async function initializeJVM() {
    try {
        log('JVM Debug API Example loaded', 'info');
        log('Starting JVM Debug initialization...', 'info');
        
        // Initialize the real JVM debug engine
        if (typeof window.JVMDebug !== 'undefined' && window.JVMDebug.BrowserJVMDebug) {
            jvmDebug = new window.JVMDebug.BrowserJVMDebug();
            
            // Set up println output callback to redirect to web console
            jvmDebug.setOutputCallback((output) => {
                // Add println output to the web UI output console
                const outputDiv = document.getElementById(DOM_IDS.OUTPUT);
                if (outputDiv) {
                    const timestamp = new Date().toLocaleTimeString();
                    const logEntry = document.createElement('div');
                    logEntry.textContent = `[${timestamp}] ${output}`;
                    logEntry.style.color = '#4ec9b0'; // Different color for program output
                    outputDiv.appendChild(logEntry);
                    outputDiv.scrollTop = outputDiv.scrollHeight; // Auto-scroll to bottom
                }
            });
            
            try {
                // Detect environment and determine data.zip URL
                const dataUrl = await getDataZipUrl();
                log(`Attempting to load data from: ${dataUrl}`, 'info');
                
                const response = await fetch(dataUrl);
                if (!response.ok) {
                    throw new Error(`Data package fetch failed (${response.status}): ${response.statusText}`);
                }
                
                const buffer = await response.arrayBuffer();
                const uint8Array = new Uint8Array(buffer);
                
                // Load as JAR archive since data.zip is essentially a zip file
                const extractedFiles = await jvmDebug.fileProvider.loadJarArchive(uint8Array, 'data.zip');
                log(`Data package loaded with ${extractedFiles.length} class files`, 'info');
                
                // Initialize the debug environment
                await jvmDebug.initialize();
                log(`Real JVM Debug initialized with ${extractedFiles.length} sample classes`, 'success');
                await populateSampleClasses();
            } catch (err) {
                log(`Failed to load data package: ${err.message}`, 'error');
                throw new Error(`Cannot initialize JVM without data package: ${err.message}`);
            }
            
            log('Real JVM Debug Interface ready! 🚀', 'success');
            
            // Enhance the existing functions with real JVM calls
            enhanceWithRealJVM();
            
            // Initialize ACE editor after JVM is ready
            setTimeout(initializeEditor, 100);
        } else {
            log('JVM Debug bundle not available - using mock implementation', 'info');
            // Still initialize editor even without JVM
            setTimeout(initializeEditor, 100);
        }
        
        // Set up state file input handler
        setupStateFileInput();
        
        // Initialize state and welcome message
        updateState(currentState);
        log('Click "Start Debugging" to begin', 'info');
        
    } catch (error) {
        logError('Failed to initialize real JVM', error);
    }
}

/**
 * Detect if we're running on GitHub Pages and return appropriate data.zip URL
 */
async function getDataZipUrl() {
    const hostname = window.location.hostname;
    const isGitHubPages = hostname.includes('github.io');
    
    if (isGitHubPages) {
        // For GitHub Pages, try the release artifact URL first
        const releaseUrl = 'https://github.com/Kreijstal/java-tools/releases/download/latest-data/data.zip';
        try {
            const testResponse = await fetch(releaseUrl, { method: 'HEAD' });
            if (testResponse.ok) {
                log('Using GitHub release artifact URL for data.zip', 'info');
                return releaseUrl;
            }
        } catch (e) {
            log('GitHub release artifact not accessible, falling back to local', 'warning');
        }
    }
    
    // Default to local path for development and fallback
    return './data.zip';
}

async function populateSampleClasses() {
    const sampleSelect = document.getElementById(DOM_IDS.SAMPLE_CLASS_SELECT);
    if (sampleSelect && jvmDebug) {
        try {
            // Get available classes from the JVM debug instance
            const availableClasses = await jvmDebug.listFiles();
            log(`Found ${availableClasses.length} classes in data.zip`, 'info');
            
            // Clear existing options except the first one
            sampleSelect.innerHTML = '<option value="">Select a sample class...</option>';
            
            // Add all classes to the dropdown
            availableClasses.forEach(cls => {
                const option = document.createElement('option');
                option.value = cls;
                option.textContent = cls.replace('.class', '');
                sampleSelect.appendChild(option);
            });
            
            // Update the heading to show the count
            const samplesHeading = document.querySelector('h4');
            if (samplesHeading && samplesHeading.textContent.includes('Sample Classes')) {
                samplesHeading.textContent = `📚 Sample Classes (${availableClasses.length} available) - or upload your own .class/.jar files`;
            }
            
            // Enable the Start Debugging button now that sample classes are available
            const debugBtn = document.getElementById(DOM_IDS.DEBUG_BTN);
            if (debugBtn) {
                debugBtn.disabled = false;
                log('Start Debugging button enabled - sample classes ready', 'info');
            }
            
        } catch (error) {
            logError('Failed to populate sample classes', error);
            throw error; // Don't hide the error with fallbacks
        }
    }
}

// Sample Class Loading
async function loadSampleClass() {
    const select = document.getElementById(DOM_IDS.SAMPLE_CLASS_SELECT);
    const selectedClass = select.value;
    
    if (!selectedClass) {
        log('Please select a sample class', 'error');
        return;
    }
    
    if (!jvmDebug) {
        throw new Error('JVM not initialized - cannot load class');
    }
    
    try {
        log(`Loading sample class: ${selectedClass}`, 'info');
        
        // Get the class data from the JVM's loaded files
        const classData = await jvmDebug.fileProvider.readFile(selectedClass);
        if (!classData) {
            throw new Error(`Class file ${selectedClass} not found in loaded data`);
        }
        
        log(`Successfully loaded ${selectedClass} (${classData.length} bytes)`, 'success');
        updateStatus(`Sample class loaded: ${selectedClass.replace('.class', '')}`, 'success');
        
        // Update the current state to enable debug buttons (but don't start debugging yet)
        updateState({
            loadedClass: { name: selectedClass, data: classData },
            className: selectedClass.replace('.class', ''),
            status: 'ready'  // Ready for debugging, not paused
        });
        
        // Enable debug button
        const debugBtn = document.getElementById(DOM_IDS.DEBUG_BTN);
        if (debugBtn) {
            debugBtn.disabled = false;
        }
        
        // Update ACE editor to show actual disassembled bytecode
        if (window.aceEditor) {
            try {
                // Get actual disassembly immediately when class is loaded
                const disassembly = jvmDebug.getClassDisassembly(classData);
                window.aceEditor.setValue(disassembly, -1);
                log(`Disassembly loaded for ${selectedClass}`, 'success');
            } catch (error) {
                // Fallback to placeholder if disassembly fails
                const className = selectedClass.replace('.class', '');
                window.aceEditor.setValue(`// Bytecode for ${className}\n// Error loading disassembly: ${error.message}\n// Click 'Start Debugging' to begin execution`, -1);
                logError('Failed to disassemble class', error);
            }
        }
        
        // Keep the selection so startDebugging knows which class to use
        // Don't clear the selection - this was causing the issue
        log(`Class ${selectedClass} loaded and ready for debugging`, 'info');
        
    } catch (error) {
        logError('Failed to load sample class', error);
        updateStatus('Failed to load sample class', 'error');
        throw error; // Don't hide errors with fallbacks
    }
}

// Helper function to update disassembly state info outside the editor
function updateDisassemblyStateInfo(view) {
    // Find or create disassembly info element
    let infoElement = document.getElementById('disassembly-info');
    if (!infoElement) {
        // Create info element above the editor
        const disassemblyPanel = document.querySelector('.debugger-panel');
        if (disassemblyPanel) {
            infoElement = document.createElement('div');
            infoElement.id = 'disassembly-info';
            infoElement.className = 'disassembly-info';
            disassemblyPanel.insertBefore(infoElement, document.getElementById(DOM_IDS.DISASSEMBLY_EDITOR));
        }
    }
    
    if (infoElement && view.classFile && view.currentPc !== undefined) {
        infoElement.innerHTML = `
            <div class="disassembly-status">
                <span class="info-label">File:</span> <span class="info-value">${view.classFile}</span>
                <span class="info-separator">|</span>
                <span class="info-label">PC:</span> <span class="info-value">${view.currentPc}</span>
            </div>
        `;
    }
}

// Debug Display Updates
function updateDebugDisplay() {
    if (!jvmDebug) return;
    
    try {
        const state = jvmDebug.getCurrentState();
        
        // Update execution state display with compact formatting - reduced whitespace
        const statusDiv = document.getElementById(DOM_IDS.EXECUTION_STATE);
        if (statusDiv) {
            const breakpoints = jvmDebug.getBreakpoints ? jvmDebug.getBreakpoints() : [];
            statusDiv.innerHTML = `<div class="state-item"><span class="key">Status:</span> <span class="value">${state.executionState}</span></div><div class="state-item"><span class="key">PC:</span> <span class="value">${state.pc !== null ? state.pc : ''}</span></div><div class="state-item"><span class="key">Method:</span> <span class="value">${state.method ? state.method.name + '([Ljava/lang/String;)V' : 'N/A'}</span></div><div class="state-item"><span class="key">Call Depth:</span> <span class="value">${state.callStackDepth}</span></div><div class="state-item"><span class="key">Breakpoints:</span> <span class="value">[${breakpoints.join(', ')}]</span></div>`;
        }
        
        // Update stack display
        const stackDiv = document.getElementById(DOM_IDS.STACK_DISPLAY);
        if (stackDiv) {
            const stackDisplay = state.stack.map((value, index) => {
                let displayValue;
                if (value === null || value === undefined) {
                    displayValue = 'null';
                } else if (typeof value === 'string') {
                    displayValue = `"${value}"`;
                } else if (typeof value === 'object') {
                    // Handle objects properly instead of showing [object Object]
                    try {
                        displayValue = JSON.stringify(value);
                    } catch (e) {
                        displayValue = value.toString();
                    }
                } else {
                    displayValue = value.toString();
                }
                return `${index}: ${displayValue}`;
            }).join('\n') || 'Empty';
            stackDiv.textContent = stackDisplay;
        }
        
        // Update locals display
        const localsDiv = document.getElementById(DOM_IDS.LOCALS_DISPLAY);
        if (localsDiv) {
            const localsDisplay = state.locals.map((value, index) => {
                let displayValue;
                if (value === null || value === undefined) {
                    displayValue = 'undefined';
                } else if (typeof value === 'string') {
                    displayValue = `"${value}"`;
                } else if (typeof value === 'object') {
                    // Handle objects properly instead of showing [object Object]
                    try {
                        displayValue = JSON.stringify(value);
                    } catch (e) {
                        displayValue = value.toString();
                    }
                } else {
                    displayValue = value.toString();
                }
                return `local_${index}: ${displayValue}`;
            }).join('\n') || 'No locals';
            localsDiv.textContent = localsDisplay;
        }
        
        // Update disassembly view with clean content and external state display
        if (state.executionState === 'paused' || state.executionState === 'running') {
            try {
                const view = jvmDebug.getDisassemblyView();
                // Reduced verbosity: Only log in verbose mode  
                // log(`Got disassembly view`, 'debug');
                
                if (view && view.formattedDisassembly) {
                    if (window.aceEditor) {
                        // Reduced verbosity: Only log in verbose mode
                        // log('Updating disassembly content', 'debug');
                        
                        // Extract clean disassembly without header/footer and line numbers
                        const lines = view.formattedDisassembly.split('\n');
                        let cleanLines = [];
                        let currentExecutionLine = -1;
                        
                        // Skip header (8. Disassembly View, ===, File:, Current PC:, empty line)
                        // And remove footer (===)
                        let startIndex = 0;
                        let endIndex = lines.length;
                        
                        // Find start (skip header)
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].startsWith('8. Disassembly View')) {
                                // Skip past header until we find content lines
                                startIndex = i + 5; // Skip the 5 header lines
                                break;
                            }
                        }
                        
                        // Find end (remove footer)
                        for (let i = lines.length - 1; i >= 0; i--) {
                            if (lines[i].includes('================')) {
                                endIndex = i;
                                break;
                            }
                        }
                        
                        // Extract content lines and clean them
                        for (let i = startIndex; i < endIndex; i++) {
                            const line = lines[i];
                            if (line.startsWith('=>')) {
                                // Current execution line - remove marker and line number
                                currentExecutionLine = cleanLines.length;
                                cleanLines.push(line.substring(8)); // Remove "=>  123  "
                            } else if (line.startsWith('  ')) {
                                // Regular line - remove line number prefix
                                cleanLines.push(line.substring(8)); // Remove "   123  "
                            } else {
                                // Line without prefix (shouldn't happen, but handle gracefully)
                                cleanLines.push(line);
                            }
                        }
                        
                        // Set clean content
                        const cleanContent = cleanLines.join('\n');
                        aceEditor.setValue(cleanContent, -1);
                        
                        // Highlight current execution line using ACE's built-in highlighting
                        aceEditor.session.clearBreakpoints();
                        if (currentExecutionLine !== -1) {
                            aceEditor.session.setBreakpoint(currentExecutionLine, 'ace_execution_line');
                            aceEditor.scrollToLine(currentExecutionLine + 1, true, true);
                        }
                        
                        // Update external disassembly state info in HTML
                        updateDisassemblyStateInfo(view);
                        
                    } else {
                        log('ACE editor not available, falling back to textarea', 'warning');
                        // Fallback to textarea if ACE editor failed
                        const editorDiv = document.getElementById(DOM_IDS.DISASSEMBLY_EDITOR);
                        if (editorDiv) {
                            const textarea = editorDiv.querySelector('textarea');
                            if (textarea) {
                                textarea.value = view.formattedDisassembly;
                            }
                        }
                    }
                } else {
                    log('No disassembly content available', 'warning');
                }
            } catch (disasmError) {
                log(`Failed to update disassembly: ${disasmError.message}`, 'error');
            }
        }
        
        // Update button states
        updateButtons();
        
    } catch (error) {
        logError('Failed to update debug display', error);
    }
}

// ACE Editor Initialization
function initializeEditor() {
    try {
        // Reduced verbosity: Only log ACE editor init in verbose mode
        // log('ACE editor initialized', 'debug');
        
        // Ensure editor container exists and has proper height
        const editorContainer = document.getElementById(DOM_IDS.DISASSEMBLY_EDITOR);
        if (!editorContainer) {
            throw new Error('Editor container not found');
        }
        
        // Set minimum height to ensure editor is visible
        if (editorContainer.style.height === '' || editorContainer.offsetHeight === 0) {
            editorContainer.style.height = '300px';
            editorContainer.style.minHeight = '300px';
        }
        
        aceEditor = ace.edit(DOM_IDS.DISASSEMBLY_EDITOR);
        
        // Configure ACE with safe defaults and error handling for theme
        try {
            aceEditor.setTheme("ace/theme/monokai");
        } catch (themeError) {
            log(`Theme loading failed, using default: ${themeError.message}`, 'warning');
            // Theme will fall back to default
        }
        
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
        
        // Make editor instance available globally
        window.aceEditor = aceEditor;
        
        log('ACE editor initialized successfully', 'success');
        
        // Add gutter click handler for breakpoints (single click and double click support)
        function toggleBreakpointAtLine(line) {
            if (jvmDebug && typeof jvmDebug.getDisassemblyView === 'function') {
                try {
                    const view = jvmDebug.getDisassemblyView();
                    if (view && view.lineToPcMap && view.lineToPcMap[line] !== undefined) {
                        const pc = view.lineToPcMap[line];
                        const breakpoints = jvmDebug.getBreakpoints();
                        
                        if (breakpoints.includes(pc)) {
                            jvmDebug.removeBreakpoint(pc);
                            aceEditor.session.clearBreakpoint(line);
                            log(`Breakpoint removed at PC=${pc}`, 'info');
                        } else {
                            jvmDebug.setBreakpoint(pc);
                            aceEditor.session.setBreakpoint(line, "ace_breakpoint");
                            log(`Breakpoint set at PC=${pc}`, 'info');
                        }
                        updateDebugDisplay();
                    }
                } catch (error) {
                    logError('Error toggling breakpoint', error);
                }
            }
        }

        aceEditor.on("guttermousedown", function(e) {
            const target = e.domEvent.target;
            if (target.className.indexOf("ace_gutter-cell") == -1) return;
            if (!e.editor.isFocused()) return;
            if (e.clientX > 25 + target.getBoundingClientRect().left) return;

            const line = e.getDocumentPosition().row;
            toggleBreakpointAtLine(line);
            e.stop();
        });

        // Also support double-click for breakpoint setting
        aceEditor.on("gutterdblclick", function(e) {
            const target = e.domEvent.target;
            if (target.className.indexOf("ace_gutter-cell") == -1) return;
            if (!e.editor.isFocused()) return;
            if (e.clientX > 25 + target.getBoundingClientRect().left) return;

            const line = e.getDocumentPosition().row;
            toggleBreakpointAtLine(line);
            e.stop();
        });
        
    } catch (e) {
        logError('ACE editor failed to initialize', e);
        // Fallback if Ace editor fails to load
        const editorDiv = document.getElementById(DOM_IDS.DISASSEMBLY_EDITOR);
        if (editorDiv) {
            editorDiv.style.height = '300px';
            editorDiv.innerHTML = 
                '<textarea readonly style="width: 100%; height: 300px; background: #1e1e1e; color: #d4d4d4; border: 1px solid #3e3e42;">Load a class to see disassembly...</textarea>';
        }
    }
}

// Helper function to handle debug operations with consistent error handling and display updates
function executeDebugOperation(operation, operationName, successMessage) {
    if (!jvmDebug) {
        throw new Error(`JVM not initialized - cannot ${operationName.toLowerCase()}`);
    }
    
    try {
        const result = operation();
        // Keep step completion messages for tests and user feedback
        log(successMessage, 'info');
        updateDebugDisplay();
        return result;
    } catch (error) {
        logError(`Failed to ${operationName}`, error);
        throw error;
    }
}

// Enhanced debugging functions
function enhanceWithRealJVM() {
    if (!jvmDebug) return;
    
    // Override startDebugging to work with real JVM and sample classes
    window.startDebugging = async function() {
        try {
            // Determine which class to start with
            let classToStart = null;
            
            // First priority: Use the currently loaded class from state
            if (currentState.loadedClass && currentState.loadedClass.name) {
                classToStart = currentState.loadedClass.name;
                // Reduced verbosity: Only log in verbose mode
                // log(`Using loaded class: ${classToStart}`, 'debug');
            } else {
                // Second priority: Check if a sample class is currently selected
                const sampleSelect = document.getElementById(DOM_IDS.SAMPLE_CLASS_SELECT);
                if (sampleSelect && sampleSelect.value) {
                    classToStart = sampleSelect.value;
                    // Reduced verbosity: Only log in verbose mode
                    // log(`Using selected class: ${classToStart}`, 'debug');
                } else {
                    // Last resort: Use the first available class from loaded classes
                    const availableClasses = await jvmDebug.listFiles();
                    if (availableClasses.length > 0) {
                        classToStart = availableClasses[0];
                        // Reduced verbosity: Only log in verbose mode
                        // log(`Using available class: ${classToStart}`, 'debug');
                    }
                }
            }
            
            if (!classToStart) {
                log('No class available to start debugging. Please load a class first.', 'error');
                return;
            }
            
            log(`Starting debug session with class: ${classToStart}`, 'info');
            const result = await jvmDebug.start(classToStart);
            updateDebugDisplay();
            
            // Update the current state to enable debug buttons
            updateState({
                loadedClass: { name: classToStart },
                className: classToStart.replace('.class', ''),
                status: 'paused'
            });
            
            updateStatus('Debugger started - Real JVM session active', 'success');
            
            // Ensure buttons are updated after starting debugging
            updateButtons();
        } catch (error) {
            // Handle classes without main method by throwing an error
            if (error.message && error.message.includes('main method not found')) {
                const className = classToStart ? classToStart.replace('.class', '') : 'unknown';
                throw new Error(`Class ${className} doesn't have a main method and cannot be executed as a standalone program`);
            } else {
                throw error;
            }
        }
    };
    
    // Override with real JVM implementations
    window.stepInto = function() {
        return executeDebugOperation(() => jvmDebug.stepInto(), 'step into', 'Step Into completed');
    };
    
    window.stepOver = function() {
        return executeDebugOperation(() => jvmDebug.stepOver(), 'step over', 'Step Over completed');
    };
    
    window.stepOut = function() {
        return executeDebugOperation(() => jvmDebug.stepOut(), 'step out', 'Step Out completed');
    };
    
    window.continue_ = function() {
        if (!jvmDebug) {
            throw new Error('JVM not initialized - cannot continue');
        }
        const result = jvmDebug.continue();
        // Reduced verbosity: Only log in verbose mode
        // log('Continue completed', 'info');
        updateDebugDisplay();
        
        // Update status based on result
        const state = jvmDebug.getCurrentState();
        if (state.executionState === 'completed') {
            updateStatus('Program execution completed', 'success');
        } else if (state.executionState === 'paused') {
            // Check if we hit a breakpoint
            const breakpoints = state.breakpoints || [];
            if (breakpoints.length > 0 && breakpoints.includes(state.pc)) {
                updateStatus(`Hit breakpoint at PC=${state.pc}`, 'info');
            } else {
                updateStatus('Execution paused', 'info');
            }
        } else {
            updateStatus('Continue execution completed', 'info');
        }
        return result;
    };
    
    window.finish = function() {
        return executeDebugOperation(() => jvmDebug.finish(), 'finish', 'Finish completed');
    };
    
    // Add stepInstruction function
    window.stepInstruction = function() {
        return executeDebugOperation(() => jvmDebug.stepInstruction(), 'step instruction', 'Step Instruction completed');
    };
    
    // Override serialize/deserialize with real JVM state
    window.serializeState = function() {
        if (!jvmDebug) {
            throw new Error('JVM not initialized - cannot serialize state');
        }
        
        const state = jvmDebug.serialize();
        const stateJson = JSON.stringify(state, null, 2);
        
        // Store in memory for testing
        window._testSerializedState = state;
        
        const blob = new Blob([stateJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `jvm-state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        log('State serialized successfully', 'success');
    };
}

// File Loading
function loadClassFile() {
    const fileInput = document.getElementById(DOM_IDS.CLASS_FILE_INPUT);
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
    
    log(`Loading ${isJar ? 'JAR' : 'class'} file: ${fileName}...`, 'info');
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const buffer = new Uint8Array(e.target.result);
            
            if (isJar) {
                // Handle JAR file
                jvmDebug.loadJar(buffer, fileName);
                log(`JAR file ${fileName} loaded successfully`, 'success');
            } else {
                // Handle .class file
                const className = fileName.replace('.class', '');
                jvmDebug.loadClass(buffer, className);
                log(`Class file ${className} loaded successfully`, 'success');
                
                // Update state to reflect loaded class
                updateState({
                    loadedClass: true,
                    className: className,
                    status: 'ready'
                });
            }
            
            // Enable debug button
            const debugBtn = document.getElementById(DOM_IDS.DEBUG_BTN);
            if (debugBtn) {
                debugBtn.disabled = false;
                log('Start Debugging button enabled', 'info');
            }
            
        } catch (error) {
            logError(`Failed to load ${fileName}`, error);
        }
    };
    
    reader.onerror = function() {
        log(`Failed to read file ${fileName}`, 'error');
    };
    
    reader.readAsArrayBuffer(file);
}

// Utility Functions for UI
function clearOutput() {
    const output = document.getElementById(DOM_IDS.OUTPUT);
    if (output) {
        output.innerHTML = '';
        log('Output console cleared.', 'info');
    }
}

function deserializeState() {
    // If we have a test state in memory, use it directly
    if (window._testSerializedState && jvmDebug) {
        jvmDebug.deserialize(window._testSerializedState);
        updateDebugDisplay();
        updateStatus('State restored successfully', 'success');
        log('JVM state restored successfully', 'success');
        return;
    }
    
    // Otherwise, trigger file input
    const input = document.getElementById(DOM_IDS.STATE_FILE_INPUT);
    if (input) {
        input.click();
    }
}

function setBreakpoint() {
    const input = document.getElementById(DOM_IDS.BREAKPOINT_INPUT);
    const pc = parseInt(input.value);
    
    if (!jvmDebug) {
        log('JVM Debug not initialized', 'error');
        return;
    }
    
    if (isNaN(pc) || pc < 0) {
        log('Invalid breakpoint location', 'error');
        return;
    }
    
    try {
        jvmDebug.setBreakpoint(pc);
        log(`Breakpoint set at PC=${pc}`, 'success');
        input.value = '';
        updateDebugDisplay();
    } catch (error) {
        logError('Failed to set breakpoint', error);
    }
}

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
        logError('Failed to clear breakpoints', error);
    }
}

// Export functions to global scope for HTML compatibility
window.log = log;
window.updateStatus = updateStatus;
window.updateState = updateState;
window.updateButtons = updateButtons;
window.loadSampleClass = loadSampleClass;
window.loadClassFile = loadClassFile;
window.clearOutput = clearOutput;
window.deserializeState = deserializeState;
window.setBreakpoint = setBreakpoint;
window.clearAllBreakpoints = clearAllBreakpoints;
window.initializeEditor = initializeEditor;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initializeJVM);