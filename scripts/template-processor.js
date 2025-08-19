/**
 * HTML Template Processor for JVM Debug Interface
 * 
 * Handles template processing with placeholders instead of massive string manipulation
 */

/**
 * Process HTML template with minimal modifications for browser compatibility
 */
function processDebugInterfaceTemplate(htmlContent) {
    console.log('📄 Processing debug interface template...');
    
    // Remove old simulated script block to prevent conflicts
    htmlContent = removeOldSimulatedScript(htmlContent);
    
    // Fix ACE editor CDN to use local copy
    htmlContent = fixAceEditorCDN(htmlContent);
    
    // Add browser-specific enhancements
    htmlContent = addBrowserUIScript(htmlContent);
    htmlContent = addXtermSupport(htmlContent);
    htmlContent = addBreakpointUI(htmlContent);
    htmlContent = updateFileInputs(htmlContent);
    htmlContent = addUIElementIds(htmlContent);
    htmlContent = addDataZipDownloadSection(htmlContent);
    
    console.log('  ✓ Template processed successfully');
    return htmlContent;
}

/**
 * Remove the old simulated JVM script to prevent conflicts
 */
function removeOldSimulatedScript(htmlContent) {
    // Target the specific script block that contains the JVM simulation
    return htmlContent.replace(/\s*<script>\s*\/\/ Real JVM debug controller using embedded jvm\.js[\s\S]*?<\/script>/s, '');
}

/**
 * Fix ACE editor CDN to use local copy
 */
function fixAceEditorCDN(htmlContent) {
    // Replace CDN link with local copy and preload theme to prevent dynamic loading issues
    return htmlContent.replace(
        /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/ace\/[^"]*\/ace\.js"><\/script>/,
        '<script src="./lib/ace.js"></script>\n    <script src="./lib/theme-monokai.js"></script>'
    );
}

/**
 * Add the browser UI enhancement script
 */
function addBrowserUIScript(htmlContent) {
    const scriptIncludes = `
    <!-- Include the real JVM debug bundle -->
    <script src="./jvm-debug.js"></script>
    
    <!-- Include browser UI enhancements -->
    <script src="./browser-ui-enhancements.js"></script>
    

    `;
    
    // Insert before closing </head> tag
    return htmlContent.replace('</head>', scriptIncludes + '</head>');
}

/**
 * Add breakpoint UI elements for test compatibility
 */
function addBreakpointUI(htmlContent) {
    // Note: Breakpoint input already exists in template, no need to add
    return htmlContent;
}

/**
 * Update file inputs to accept both .class and .jar files
 */
function updateFileInputs(htmlContent) {
    // Update file input to accept both .class and .jar files
    const fileInputPattern = /(<input type="file" id="classFileInput" accept="\.class"[^>]*>)/;
    htmlContent = htmlContent.replace(fileInputPattern, '<input type="file" id="classFileInput" accept=".class,.jar" style="margin-right: 10px;" title="Upload .class or .jar files">');
    
    // Update the load button text to reflect unified functionality
    const loadButtonPattern = /(<button onclick="loadClassFile\(\)" id="loadBtn">)Load Class(<\/button>)/;
    htmlContent = htmlContent.replace(loadButtonPattern, '$1Upload Custom File$2');
    
    return htmlContent;
}

/**
 * Add IDs and text to buttons for test compatibility
 */
function addUIElementIds(htmlContent) {
    // Add deserializeBtn ID to the restore state button
    const restoreButtonPattern = /(<button onclick="document\.getElementById\('stateFileInput'\)\.click\(\)"[^>]*>📂<\/button>)/;
    htmlContent = htmlContent.replace(restoreButtonPattern, '<button onclick="deserializeState()" id="deserializeBtn" title="Restore State">📂 Restore State</button>');
    
    // Add ID and text to the serialize button
    const serializeButtonPattern = /(<button onclick="serializeState\(\)" title="Serialize State">💾<\/button>)/;
    htmlContent = htmlContent.replace(serializeButtonPattern, '<button onclick="serializeState()" id="serializeBtn" title="Serialize State">💾 Serialize State</button>');
    
    // Add Clear button to output console
    const outputConsolePattern = /(<h3>Output Console<\/h3>)/;
    htmlContent = htmlContent.replace(outputConsolePattern, '$1\n                <button onclick="clearOutput()" style="float: right; font-size: 10px; padding: 2px 6px;">Clear</button>');
    
    return htmlContent;
}

/**
 * Add data.zip download section for GitHub Pages deployment
 */
function addDataZipDownloadSection(htmlContent) {
    // Find the sample classes section and add download section before it
    const sampleClassesPattern = /(<h4>📚 Sample Classes[^<]*<\/h4>)/;
    const downloadSection = `
        <!-- Data Package Download Section for GitHub Pages -->
        <h3>📚 Getting Sample .class Files to Try</h3>
        <p>Download the complete sample class files package to try different examples locally:</p>
        <div class="button-group">
            <a href="./data.zip" download="java-class-samples.zip" style="
                display: inline-block; 
                background-color: #0e639c; 
                color: white; 
                padding: 8px 16px; 
                text-decoration: none; 
                border-radius: 3px; 
                font-family: inherit; 
                font-size: 12px;
                border: none;
            ">📦 Download data.zip</a>
            <span style="margin-left: 10px; color: #888; font-size: 11px;">
                Contains 25 sample .class files (~13KB)
            </span>
        </div>
        <p style="font-size: 11px; color: #888; margin-bottom: 20px;">
            Or select from pre-loaded samples below:
        </p>
        
        $1`;
    
    return htmlContent.replace(sampleClassesPattern, downloadSection);
}

/**
 * Add XTerm.js support for enhanced terminal I/O
 */
function addXtermSupport(htmlContent) {
    // Add XTerm CSS import to head
    const headPattern = /(<\/head>)/;
    const xtermCSS = '    <link rel="stylesheet" href="./lib/xterm.css">\n$1';
    htmlContent = htmlContent.replace(headPattern, xtermCSS);
    
    // Add toggle button after the "Clear" button in Output Console section
    const clearButtonPattern = /(<button onclick="clearOutput\(\)" style="float: right; font-size: 10px; padding: 2px 6px;">Clear<\/button>)/;
    const toggleButton = `$1
                <button onclick="toggleOutputMode()" id="toggle-output-btn" style="float: right; margin-right: 10px; font-size: 10px; padding: 2px 6px;">Use XTerm Output</button>`;
    htmlContent = htmlContent.replace(clearButtonPattern, toggleButton);
    
    // Initialize XTerm when page loads by adding to the DOMContentLoaded event
    const domContentLoadedPattern = /(document\.addEventListener\('DOMContentLoaded', \(\) => \{[^}]*initializeEditor\(\);)/;
    const xtermInit = `$1
            
            // Initialize XTerm support (optional)
            initializeXterm().then(success => {
                if (success) {
                    log('XTerm.js available - toggle output mode to use terminal I/O with ANSI support', 'info');
                }
            }).catch(err => {
                log('XTerm.js not available - using DOM output only', 'info');
            });`;
    htmlContent = htmlContent.replace(domContentLoadedPattern, xtermInit);
    
    return htmlContent;
}

/**
 * Create README content for the GitHub Pages site
 */
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

module.exports = {
    processDebugInterfaceTemplate,
    createSiteReadme
};