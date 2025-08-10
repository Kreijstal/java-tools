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

// Step 1: Build the browser bundle using webpack
console.log('📦 Building browser bundle with Webpack...');
try {
    execSync('npx webpack --mode production', { stdio: 'inherit' });
    console.log('  ✓ Bundle created successfully');
} catch (error) {
    console.error('❌ Webpack build failed:', error.message);
    process.exit(1);
}

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
    <!-- GitHub Pages Enhancements with Real JVM Integration -->
    <meta name="description" content="Interactive JVM Debug Interface - Step-by-step Java bytecode execution with real-time visualization">
    <meta name="keywords" content="JVM, Java, bytecode, debugger, visualization, interactive">
    <meta name="author" content="java-tools">
    
    <!-- Include the real JVM debug bundle -->
    <script src="./jvm-debug.js"></script>
    
    <!-- Real JVM Debug Integration -->
    <script>
        // Real JVM Debug implementation using the actual JVM logic
        let jvmDebug = null;
        
        // Initialize the real JVM debug interface
        async function initializeRealJVM() {
            try {
                jvmDebug = new JVMDebug.BrowserJVMDebug();
                
                // Load data package if available
                try {
                    const response = await fetch('./data/metadata.json');
                    if (response.ok) {
                        const dataPackage = await response.json();
                        await jvmDebug.initialize({ dataPackage });
                        log(\`Initialized with \${dataPackage.classes?.length || 0} classes\`, 'success');
                        populateSampleClasses(dataPackage.classes || []);
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
        
        // Enhanced file upload with real class loading
        function addRealFileUpload() {
            const controls = document.querySelector('.controls');
            const fileUploadDiv = document.createElement('div');
            fileUploadDiv.innerHTML = \`
                <h4>📁 Upload Custom Class File</h4>
                <input type="file" id="classFileInput" accept=".class,.jar" multiple />
                <button onclick="loadCustomFiles()">Load Files</button>
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
                const result = await jvmDebug.start(selectedClass);
                log(\`Debug session started for \${selectedClass}\`, 'success');
                log(\`Status: \${result.status}\`, 'info');
                updateDebugDisplay();
            } catch (error) {
                log(\`Failed to start debugging \${selectedClass}: \${error.message}\`, 'error');
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
                
                // Update status display
                const statusDiv = document.querySelector('.debug-status');
                if (statusDiv) {
                    statusDiv.innerHTML = \`
                        <h4>🔍 Debug Status</h4>
                        <p><strong>State:</strong> \${state.executionState}</p>
                        <p><strong>PC:</strong> \${state.pc !== null ? state.pc : 'N/A'}</p>
                        <p><strong>Method:</strong> \${state.method ? state.method.name : 'N/A'}</p>
                        <p><strong>Call Depth:</strong> \${state.callStackDepth}</p>
                        <p><strong>Breakpoints:</strong> [\${state.breakpoints.join(', ')}]</p>
                    \`;
                }
                
                // Update stack display
                const stackDiv = document.querySelector('.stack-display');
                if (stackDiv) {
                    const stackDisplay = state.stack.map((value, index) => 
                        \`\${index}: \${typeof value === 'string' ? '"\${value}"' : value}\`
                    ).join('\\n') || 'Empty';
                    
                    stackDiv.innerHTML = \`
                        <h4>📚 Stack (\${state.stack.length} items)</h4>
                        <pre>\${stackDisplay}</pre>
                    \`;
                }
                
                // Update locals display
                const localsDiv = document.querySelector('.locals-display');
                if (localsDiv) {
                    const localsDisplay = state.locals.map((value, index) => 
                        \`local_\${index}: \${value !== undefined && value !== null ? 
                            (typeof value === 'string' ? '"\${value}"' : value) : 'undefined'}\`
                    ).join('\\n') || 'No locals';
                    
                    localsDiv.innerHTML = \`
                        <h4>🔧 Local Variables (\${state.locals.length} slots)</h4>
                        <pre>\${localsDisplay}</pre>
                    \`;
                }
                
            } catch (error) {
                log(\`Failed to update debug display: \${error.message}\`, 'error');
            }
        }
        
        // Add display panels for debug information
        function addDebugDisplayPanels() {
            const container = document.querySelector('.container');
            if (container) {
                const debugInfo = document.createElement('div');
                debugInfo.innerHTML = \`
                    <div class="panel debug-status">
                        <h4>🔍 Debug Status</h4>
                        <p>Not started</p>
                    </div>
                    <div class="panel stack-display">
                        <h4>📚 Stack</h4>
                        <pre>Empty</pre>
                    </div>
                    <div class="panel locals-display">
                        <h4>🔧 Local Variables</h4>
                        <pre>No locals</pre>
                    </div>
                \`;
                container.appendChild(debugInfo);
            }
        }
        
        // Initialize everything when page loads
        document.addEventListener('DOMContentLoaded', async function() {
            log('Initializing Real JVM Debug Interface...', 'info');
            
            const success = await initializeRealJVM();
            if (success) {
                addRealFileUpload();
                addDebugDisplayPanels();
                log('Real JVM Debug Interface ready! 🚀', 'success');
            } else {
                log('Failed to initialize JVM Debug Interface', 'error');
            }
        });
    </script>
    `;
    
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