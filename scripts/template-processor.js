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
    // First, remove any existing incorrect script tags with ../dist/ paths
    htmlContent = removeIncorrectScriptPaths(htmlContent);
    
    const scriptIncludes = `
    <!-- Include the real JVM debug bundle -->
    <script src="./jvm-debug.js"></script>
    
    <!-- Include browser UI enhancements -->
    <script src="./browser-ui-enhancements.js"></script>
    
    <!-- Include AWT framework for browser-based AWT support -->
    <script src="./awt.js"></script>
    
    `;
    
    // Insert before closing </head> tag
    return htmlContent.replace('</head>', scriptIncludes + '</head>');
}

/**
 * Remove script tags with incorrect ../dist/ paths
 */
function removeIncorrectScriptPaths(htmlContent) {
    // Remove the jvm-debug.js script with incorrect path
    htmlContent = htmlContent.replace(/\s*<!-- Include the real JVM debug bundle -->\s*<script src="\.\.\/dist\/jvm-debug\.js"><\/script>\s*/, '');
    
    // Remove the browser-ui-enhancements.js script with incorrect path  
    htmlContent = htmlContent.replace(/\s*<!-- Include browser UI enhancements -->\s*<script src="\.\.\/dist\/browser-ui-enhancements\.js"><\/script>\s*/, '');
    
    // Remove the awt.js script with incorrect path
    htmlContent = htmlContent.replace(/\s*<!-- Include AWT framework for browser-based AWT support -->\s*<script src="\.\.\/dist\/awt\.js"><\/script>\s*/, '');
    
    return htmlContent;
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
    const fileInputPattern = /<input type="file" id="classFileInput"([^>]*)>/;
    htmlContent = htmlContent.replace(fileInputPattern, (match, attrs) => {
        let updatedAttrs = attrs;
        if (/accept=/.test(updatedAttrs)) {
            updatedAttrs = updatedAttrs.replace(/accept="[^"]*"/, 'accept=".class,.jar"');
        } else {
            updatedAttrs += ' accept=".class,.jar"';
        }
        if (!/title=/.test(updatedAttrs)) {
            updatedAttrs += ' title="Upload .class or .jar files"';
        }
        return `<input type="file" id="classFileInput"${updatedAttrs}>`;
    });

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
        <details class="sample-download">
            <summary>📦 Download bundle</summary>
            <div class="button-group" style="margin-top: 8px;">
                <a href="./data.zip" download="java-class-samples.zip" style="
                    display: inline-block; 
                    background-color: #0e639c; 
                    color: white; 
                    padding: 6px 12px; 
                    text-decoration: none; 
                    border-radius: 3px; 
                    font-family: inherit; 
                    font-size: 12px;
                    border: none;
                ">Download data.zip</a>
            </div>
            <div class="download-note">Includes the same sample classes used in the browser list.</div>
        </details>
        
        $1`;
    
    return htmlContent.replace(sampleClassesPattern, downloadSection);
}

/**
 * Add XTerm.js support for enhanced terminal I/O
 */
function addXtermSupport(htmlContent) {
    // Add XTerm CSS and JS imports using local files instead of CDN
    const headPattern = /(<\/head>)/;
    const xtermIncludes = `    <link rel="stylesheet" href="./lib/xterm.css">
    <script src="./lib/xterm.js"></script>
    <script src="./lib/addon-fit.js"></script>
$1`;
    htmlContent = htmlContent.replace(headPattern, xtermIncludes);
    
    // XTerm toggle button functionality removed - both XTerm and DOM output are now always available
    
    // Initialize XTerm when page loads by adding to the DOMContentLoaded event
    const domContentLoadedPattern = /(document\.addEventListener\('DOMContentLoaded', \(\) => \{[^}]*initializeEditor\(\);)/;
    const xtermInit = `$1
            
            // Initialize XTerm support for Java program output
            setupXtermIntegration();`;
    htmlContent = htmlContent.replace(domContentLoadedPattern, xtermInit);
    
    return htmlContent;
}



module.exports = {
    processDebugInterfaceTemplate
};
