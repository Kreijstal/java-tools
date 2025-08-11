const test = require('tape');
const fs = require('fs');
const path = require('path');

test('Sample class selection functionality', async (t) => {
    try {
        // Test 1: Check that data.zip exists
        const dataZipPath = path.join(__dirname, '..', 'dist', 'data.zip');
        t.true(fs.existsSync(dataZipPath), 'data.zip should exist');
        
        // Test 2: Verify actual class files exist in dist/data
        const dataDir = path.join(__dirname, '..', 'dist', 'data');
        if (fs.existsSync(dataDir)) {
            const classFiles = fs.readdirSync(dataDir).filter(file => file.endsWith('.class'));
            t.true(classFiles.length > 0, 'Should have .class files in dist/data directory');
            
            // Check a few specific files
            t.true(classFiles.includes('Hello.class'), 'Should include Hello.class');
            t.true(classFiles.includes('VerySimple.class'), 'Should include VerySimple.class');
            t.true(classFiles.includes('RuntimeArithmetic.class'), 'Should include RuntimeArithmetic.class');
        } else {
            t.fail('dist/data directory not found - run npm run generate first');
        }
        
        t.pass('Sample class selection functionality tests passed');
        
    } catch (error) {
        t.fail(`Test failed with error: ${error.message}`);
    }
    
    t.end();
});