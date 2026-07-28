const test = require('tape');
const fs = require('fs');
const path = require('path');

test('Sample data directory ships sources and a manifest', async (t) => {
    try {
        const dataDir = path.join(__dirname, '..', 'dist', 'data');
        const manifestPath = path.join(dataDir, 'manifest.json');
        t.true(fs.existsSync(manifestPath), 'dist/data/manifest.json should exist (run npm run generate first)');

        const sourceFiles = fs.readdirSync(dataDir).filter(file => file.endsWith('.java'));
        t.true(sourceFiles.length > 0, 'Should have .java sources in dist/data directory');
        t.true(sourceFiles.includes('Hello.java'), 'Should include Hello.java');
        t.true(sourceFiles.includes('VerySimple.java'), 'Should include VerySimple.java');
        t.true(sourceFiles.includes('RuntimeArithmetic.java'), 'Should include RuntimeArithmetic.java');

        const classFiles = fs.readdirSync(dataDir).filter(file => file.endsWith('.class'));
        t.equal(classFiles.length, 0, 'dist/data should not ship pre-compiled classes');

        t.pass('Sample data directory tests passed');
    } catch (error) {
        t.fail(`Test failed with error: ${error.message}`);
    }

    t.end();
});
