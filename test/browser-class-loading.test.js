const test = require('tape');
const path = require('path');
const fs = require('fs');
const BrowserFileProvider = require('../src/BrowserFileProvider');

test('BrowserFileProvider should load class files with content', async (t) => {
    const provider = new BrowserFileProvider();
    
    // Mock data package with class content (simulating the fix)
    const mockDataPackage = {
        classes: [
            {
                name: 'CalcMain',
                filename: 'CalcMain.class',
                size: 436,
                description: 'CalcMain class file for JVM execution',
                content: 'yv66vgAAADQAHQoABgAOCQAPABAKABEAEgsAEwAUBwAVBwAWAQAGPGluaXQ+AQADKClWAQAEQ29kZQEAD0xpbmVOdW1iZXJUYWJsZQEABG1haW4BABYoW0xqYXZhL2xhbmcvU3RyaW5nOylWAQAKU291cmNlRmlsZQEADENhbGNNYWluLmphdmEMAAcACAAHABcMABgAGQcAGgwAGwAcBwAdDAAeAB8BAAhDYWxjTWFpbgEAEGphdmEvbGFuZy9PYmplY3QBAAhDYWxjdWxhdG9yAQADYWRkAQAHKElJKUkBABBqYXZhL2xhbmcvU3lzdGVtAQADb3V0AQAVTGphdmEvaW8vUHJpbnRTdHJlYW07AQATamF2YS9pby9QcmludFN0cmVhbQEAB3ByaW50bG4BAAQoSSlWACEABQAGAAAAAAACAAEABwAIAAEACQAAAB0AAQABAAAABSq3AAGxAAAAAQAKAAAABgABAAAAAgAJAAsADAABAAkAAAAmAAQAAwAAAAq4AAK4AAO2AASxAAAAAQAKAAAACgACAAAABAAJAAUAAQANAAAAAgAO' // base64 encoded CalcMain.class
            }
        ]
    };
    
    // Load the data package
    await provider.loadDataPackage(mockDataPackage);
    
    // Test that the file exists in virtual file system
    const exists = await provider.exists('CalcMain.class');
    t.true(exists, 'CalcMain.class should exist in virtual file system after loading data package');
    
    // Test that we can read the file content
    const content = await provider.readFile('CalcMain.class');
    t.true(content instanceof Uint8Array, 'File content should be a Uint8Array');
    t.true(content.length > 0, 'File content should not be empty');
    
    // Test that the file size is correct
    const size = provider.getFileSize('CalcMain.class');
    t.equal(size, content.length, 'File size should match content length');
    
    t.end();
});

test('BrowserFileProvider should handle metadata-only package gracefully', async (t) => {
    const provider = new BrowserFileProvider();
    
    // Mock metadata-only package (like the original bug scenario)
    const metadataOnlyPackage = {
        classes: [
            {
                name: 'CalcMain',
                filename: 'CalcMain.class',
                size: 436,
                description: 'CalcMain class file for JVM execution'
                // Note: no 'content' property
            }
        ]
    };
    
    // Load the metadata-only package
    await provider.loadDataPackage(metadataOnlyPackage);
    
    // Test that the file does NOT exist in virtual file system (because no content was provided)
    const exists = await provider.exists('CalcMain.class');
    t.false(exists, 'CalcMain.class should NOT exist in virtual file system when no content is provided');
    
    // Test that listing files returns empty
    const files = await provider.listFiles();
    t.equal(files.length, 0, 'No files should be available when no content is provided');
    
    t.end();
});

test('Browser initialization should load actual class files', async (t) => {
    // This test simulates the fixed browser initialization
    // We check that actual class files would be loaded when metadata.json and class files are available
    
    const provider = new BrowserFileProvider();
    
    // Simulate loading CalcMain.class from the file system (as the fix does)
    const calcMainPath = path.join(__dirname, '../sources/CalcMain.class');
    
    if (fs.existsSync(calcMainPath)) {
        const classContent = fs.readFileSync(calcMainPath);
        const base64Content = classContent.toString('base64');
        
        const dataPackage = {
            classes: [
                {
                    name: 'CalcMain',
                    filename: 'CalcMain.class', 
                    size: classContent.length,
                    description: 'CalcMain class file for JVM execution',
                    content: base64Content
                }
            ]
        };
        
        await provider.loadDataPackage(dataPackage);
        
        // Verify the class file was loaded correctly
        const exists = await provider.exists('CalcMain.class');
        t.true(exists, 'CalcMain.class should exist after proper loading');
        
        const loadedContent = await provider.readFile('CalcMain.class');
        t.equal(loadedContent.length, classContent.length, 'Loaded content should match original file size');
        
        // Verify content matches
        const originalBytes = new Uint8Array(classContent);
        t.deepEqual(loadedContent, originalBytes, 'Loaded content should match original file content');
        
    } else {
        t.skip('CalcMain.class not found, skipping real file test');
    }
    
    t.end();
});