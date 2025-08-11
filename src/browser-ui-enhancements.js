/**
 * Browser UI Enhancement Module for JVM Debug Interface
 * 
 * This module provides the browser-specific UI functionality for the JVM debug interface.
 * Previously this was hardcoded as a massive string injection in buildSite.js.
 */

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
    const output = document.getElementById('output');
    if (output) {
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.innerHTML = `[${timestamp}] ${message}`;
        output.appendChild(logEntry);
        output.scrollTop = output.scrollHeight;
    }
    console.log(`[${type.toUpperCase()}] ${message}`);
}

function updateStatus(message, type = 'info') {
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
    }
    log(message, type);
}

function updateState(updates) {
    Object.assign(currentState, updates);
    log(`State updated: ${JSON.stringify(updates)}`, 'debug');
}

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
        
        log(`Debug buttons ${isPaused ? 'enabled' : 'disabled'} (state: ${state.executionState})`, 'debug');
        
    } catch (error) {
        log(`Error updating buttons: ${error.message}`, 'error');
        // Fallback to simple state check
        const isDebugging = currentState.status === 'paused' || currentState.status === 'running';
        const debugButtons = ['stepIntoBtn', 'stepOverBtn', 'stepOutBtn', 'stepInstructionBtn', 'continueBtn', 'finishBtn'];
        
        debugButtons.forEach(btnId => {
            const btn = document.getElementById(btnId);
            if (btn) {
                btn.disabled = !isDebugging;
            }
        });
        
        log(`Debug buttons ${isDebugging ? 'enabled' : 'disabled'} (fallback)`, 'debug');
    }
}

// Class Descriptions
function getClassDescription(className) {
    const descriptions = {
        'VerySimple.class': 'Basic arithmetic (3-2=1)',
        'Hello.class': 'Hello World program',  
        'Calculator.class': 'Calculator operations',
        'Calc.class': 'Simple calculation demo',
        'CalcMain.class': 'Main calculation entry point',
        'RuntimeArithmetic.class': 'Runtime arithmetic operations',
        'ArithmeticTest.class': 'Arithmetic operation tests',
        'ConstantsTest.class': 'Constant loading tests',
        'DivisionTest.class': 'Division operation tests',
        'SmallDivisionTest.class': 'Small division tests',
        'WorkingArithmetic.class': 'Working arithmetic examples',
        'SimpleArithmetic.class': 'Simple arithmetic operations',
        'StringConcat.class': 'String concatenation',
        'SimpleStringConcat.class': 'Simple string concatenation',
        'StringBuilderConcat.class': 'StringBuilder concatenation',
        'StringConcatMethod.class': 'String concatenation methods',
        'StringMethodsTest.class': 'String method tests',
        'TestMethods.class': 'Method testing examples',
        'TestMethodsRunner.class': 'Test method runner',
        'ExceptionTest.class': 'Exception handling tests',
        'InvokeVirtualTest.class': 'Virtual method invocation tests',
        'MainApp.class': 'Main application entry point',
        'SipushTest.class': 'Short integer push tests',
        'Thing.class': 'Generic object example',
        'ThingProducer.class': 'Object factory example'
    };
    return descriptions[className] || 'Java class file';
}

// JVM Integration Functions
async function initializeJVM() {
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
                    log(`Data package loaded with ${extractedFiles.length} class files`, 'info');
                    
                    // Initialize the debug environment
                    await jvmDebug.initialize();
                    log(`Real JVM Debug initialized with ${extractedFiles.length} sample classes`, 'success');
                    await populateSampleClasses();
                } else {
                    log('Data package fetch failed, initializing without data', 'warning');
                    await jvmDebug.initialize();
                    log('Real JVM Debug initialized (no data package)', 'info');
                }
            } catch (err) {
                log(`Data package error: ${err.message}`, 'warning');
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
        log(`Failed to initialize real JVM: ${error.message}`, 'error');
    }
}

async function populateSampleClasses() {
    const controls = document.querySelector('.controls');
    if (controls && jvmDebug) {
        try {
            // Get available classes from the JVM debug instance
            let availableClasses = [];
            try {
                availableClasses = jvmDebug ? await jvmDebug.listFiles() : [];
            } catch (error) {
                log('Could not retrieve class list, using default classes', 'info');
                availableClasses = [];
            }
            
            const classes = availableClasses.length > 0 ? 
                availableClasses.map(cls => ({
                    filename: cls,
                    name: cls.replace('.class', ''),
                    description: getClassDescription(cls)
                })) :
                [
                    { filename: 'VerySimple.class', name: 'VerySimple', description: 'Basic arithmetic (3-2=1)' },
                    { filename: 'Hello.class', name: 'Hello', description: 'Hello World program' },
                    { filename: 'Calculator.class', name: 'Calculator', description: 'Calculator operations' }
                ];
            
            const samplesDiv = document.createElement('div');
            samplesDiv.innerHTML = `
                <h4>📚 Sample Classes (${classes.length} available) - or upload your own .class/.jar files</h4>
                <select id="sampleClassSelect">
                    <option value="">Select a sample class...</option>
                    ${classes.map(cls => 
                        `<option value="${cls.filename}">${cls.name} - ${cls.description}</option>`
                    ).join('')}
                </select>
                <button onclick="loadSampleClass()">Load Sample</button>
            `;
            controls.appendChild(samplesDiv);
            
            // Enable the Start Debugging button now that sample classes are available
            const debugBtn = document.getElementById('debugBtn');
            if (debugBtn) {
                debugBtn.disabled = false;
                log('Start Debugging button enabled - sample classes ready', 'info');
            }
            
            // Also update the state to indicate we have classes available
            if (typeof updateState === 'function') {
                const firstClass = classes.length > 0 ? classes[0] : null;
                updateState({
                    loadedClass: true,
                    className: firstClass ? firstClass.name : null,
                    status: 'ready'
                });
            }
        } catch (error) {
            log(`Failed to populate sample classes: ${error.message}`, 'error');
        }
    }
}

// Sample Class Loading
async function loadSampleClass() {
    const select = document.getElementById('sampleClassSelect');
    const selectedClass = select.value;
    
    if (!selectedClass || !jvmDebug) {
        log('Please select a sample class and ensure JVM is initialized', 'error');
        return;
    }
    
    try {
        log(`Loading sample class: ${selectedClass}`, 'info');
        
        const result = await jvmDebug.start(selectedClass);
        log(`Debug session started for ${selectedClass}`, 'success');
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
        log(`Failed to start debugging ${selectedClass}: ${error.message}`, 'error');
    }
}

// Debug Display Updates
function updateDebugDisplay() {
    if (!jvmDebug) return;
    
    try {
        const state = jvmDebug.getCurrentState();
        
        // Update execution state display
        const statusDiv = document.getElementById('executionState');
        if (statusDiv) {
            statusDiv.innerHTML = `
                <div><span class="key">Status:</span> <span class="value">${state.executionState}</span></div>
                <div><span class="key">PC:</span> <span class="value">${state.pc !== null ? state.pc : 'N/A'}</span></div>
                <div><span class="key">Method:</span> <span class="value">${state.method ? state.method.name + '([Ljava/lang/String;)V' : 'N/A'}</span></div>
                <div><span class="key">Call Depth:</span> <span class="value">${state.callStackDepth}</span></div>
                <div><span class="key">Breakpoints:</span> <span class="value">[${state.breakpoints.join(', ')}]</span></div>
            `;
        }
        
        // Update stack display
        const stackDiv = document.getElementById('stackDisplay');
        if (stackDiv) {
            const stackDisplay = state.stack.map((value, index) => 
                `${index}: ${typeof value === 'string' ? '"${value}"' : value}`
            ).join('\n') || 'Empty';
            stackDiv.textContent = stackDisplay;
        }
        
        // Update locals display
        const localsDiv = document.getElementById('localsDisplay');
        if (localsDiv) {
            const localsDisplay = state.locals.map((value, index) => 
                `local_${index}: ${value !== undefined && value !== null ? 
                    (typeof value === 'string' ? '"${value}"' : value) : 'undefined'}`
            ).join('\n') || 'No locals';
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
                log(`Failed to update disassembly: ${disasmError.message}`, 'error');
            }
        }
        
        // Update button states
        if (typeof updateButtons === 'function') {
            updateButtons();
        }
        
    } catch (error) {
        log(`Failed to update debug display: ${error.message}`, 'error');
    }
}

// ACE Editor Initialization
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
                            log(`Breakpoint removed at PC=${pc}`, 'info');
                        } else {
                            jvmDebug.setBreakpoint(pc);
                            aceEditor.session.setBreakpoint(line, "ace_breakpoint");
                            log(`Breakpoint set at PC=${pc}`, 'info');
                        }
                        updateDebugDisplay();
                    }
                } catch (error) {
                    log(`Error toggling breakpoint: ${error.message}`, 'error');
                }
            }
            e.stop();
        });
        
    } catch (e) {
        log(`ACE editor failed to load: ${e.message}`, 'warning');
        // Fallback if Ace editor fails to load
        const editorDiv = document.getElementById('disassembly-editor');
        if (editorDiv) {
            editorDiv.innerHTML = 
                '<textarea readonly style="width: 100%; height: 300px; background: #1e1e1e; color: #d4d4d4; border: 1px solid #3e3e42;">Load a class to see disassembly...</textarea>';
        }
    }
}

// Enhanced debugging functions
function enhanceWithRealJVM() {
    if (!jvmDebug) return;
    
    // Store original functions if they exist
    const originalStartDebugging = window.startDebugging;
    const originalStepInto = window.stepInto;
    const originalStepOver = window.stepOver;
    const originalStepOut = window.stepOut;
    const originalContinue = window.continue_;
    const originalFinish = window.finish;
    
    // Override startDebugging to work with real JVM and sample classes
    window.startDebugging = async function() {
        try {
            // Determine which class to start with
            let classToStart = null;
            
            // First, check if a sample class is selected
            const sampleSelect = document.getElementById('sampleClassSelect');
            if (sampleSelect && sampleSelect.value) {
                classToStart = sampleSelect.value;
            } else {
                // Use the first available class from loaded classes
                let availableClasses = [];
                try {
                    availableClasses = await jvmDebug.listFiles();
                } catch (error) {
                    log('Could not retrieve class list', 'error');
                }
                if (availableClasses.length > 0) {
                    classToStart = availableClasses[0];
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
            if (typeof updateState === 'function') {
                updateState({
                    loadedClass: { name: classToStart },
                    className: classToStart.replace('.class', ''),
                    status: 'paused'
                });
            }
            
            if (typeof updateStatus === 'function') {
                updateStatus('Debugger started - Real JVM session active', 'success');
            }
            
            // Ensure buttons are updated after starting debugging
            if (typeof updateButtons === 'function') {
                updateButtons();
            }
        } catch (error) {
            log(`Failed to start debugging: ${error.message}`, 'error');
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
            log(`Step into failed: ${error.message}`, 'error');
            if (originalStepInto) originalStepInto();
        }
    };
    
    window.stepOver = function() {
        try {
            const result = jvmDebug.stepOver();
            log('Step Over completed', 'info');
            updateDebugDisplay();
        } catch (error) {
            log(`Step over failed: ${error.message}`, 'error');
            if (originalStepOver) originalStepOver();
        }
    };
    
    window.stepOut = function() {
        try {
            const result = jvmDebug.stepOut();
            log('Step Out completed', 'info');
            updateDebugDisplay();
        } catch (error) {
            log(`Step out failed: ${error.message}`, 'error');
            if (originalStepOut) originalStepOut();
        }
    };
    
    window.continue_ = function() {
        try {
            const result = jvmDebug.continue();
            log('Continue completed', 'info');
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
        } catch (error) {
            log(`Continue failed: ${error.message}`, 'error');
            if (originalContinue) originalContinue();
        }
    };
    
    window.finish = function() {
        try {
            const result = jvmDebug.finish();
            log('Finish completed', 'info');
            updateDebugDisplay();
        } catch (error) {
            log(`Finish failed: ${error.message}`, 'error');
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
                log(`Step instruction failed: ${error.message}`, 'error');
            }
        };
    }
    
    // Override serialize/deserialize with real JVM state
    const originalSerialize = window.serializeState;
    window.serializeState = function() {
        try {
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
        } catch (error) {
            log(`State serialization failed: ${error.message}`, 'error');
            if (originalSerialize) originalSerialize();
        }
    };
}

// File Loading
function loadClassFile() {
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
            log(`Failed to load ${fileName}: ${error.message}`, 'error');
        }
    };
    
    reader.onerror = function() {
        log(`Failed to read file ${fileName}`, 'error');
    };
    
    reader.readAsArrayBuffer(file);
}

// Utility Functions for UI
function clearOutput() {
    const output = document.getElementById('output');
    if (output) {
        output.innerHTML = '';
        if (typeof log === 'function') {
            log('Output console cleared.', 'info');
        }
    }
}

function deserializeState() {
    // If we have a test state in memory, use it directly
    if (window._testSerializedState && typeof jvmDebug !== 'undefined' && jvmDebug) {
        try {
            jvmDebug.deserialize(window._testSerializedState);
            if (typeof updateDebugDisplay === 'function') {
                updateDebugDisplay();
            }
            updateStatus('State restored successfully', 'success');
            log('JVM state restored successfully', 'success');
            return;
        } catch (error) {
            log(`Memory state restore failed: ${error.message}`, 'error');
        }
    }
    
    // Otherwise, trigger file input
    const input = document.getElementById('stateFileInput');
    if (input) {
        input.click();
    }
}

function setBreakpoint() {
    const input = document.getElementById('breakpointInput');
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
        log(`Failed to set breakpoint: ${error.message}`, 'error');
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
        log(`Failed to clear breakpoints: ${error.message}`, 'error');
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