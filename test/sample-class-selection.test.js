const test = require('tape');
const fs = require('fs');
const path = require('path');

test('Sample class selection functionality', async (t) => {
    try {
        // Test 1: Check that data.zip exists and contains 25 class files
        const dataZipPath = path.join(__dirname, '..', 'dist', 'data.zip');
        t.true(fs.existsSync(dataZipPath), 'data.zip should exist');
        
        // Test 2: Check that metadata.json exists and has 25 classes
        const metadataPath = path.join(__dirname, '..', 'dist', 'data', 'metadata.json');
        if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            t.equal(metadata.totalFiles, 25, 'metadata.json should indicate 25 total files');
            t.equal(metadata.classes.length, 25, 'metadata.json should have 25 class entries');
            
            // Test 3: Verify all expected classes are present
            const expectedClasses = [
                'ArithmeticTest', 'Calc', 'CalcMain', 'Calculator', 'ConstantsTest',
                'DivisionTest', 'ExceptionTest', 'Hello', 'InvokeVirtualTest', 'MainApp',
                'RuntimeArithmetic', 'SimpleArithmetic', 'SimpleStringConcat', 'SipushTest',
                'SmallDivisionTest', 'StringBuilderConcat', 'StringConcat', 'StringConcatMethod',
                'StringMethodsTest', 'TestMethods', 'TestMethodsRunner', 'Thing', 'ThingProducer',
                'VerySimple', 'WorkingArithmetic'
            ];
            
            const classNames = metadata.classes.map(cls => cls.name);
            expectedClasses.forEach(className => {
                t.true(classNames.includes(className), `Should include ${className} class`);
            });
            
            // Test 4: Verify that each class has proper description
            metadata.classes.forEach(cls => {
                t.true(cls.description && cls.description.length > 0, `${cls.name} should have a description`);
                t.true(cls.filename && cls.filename.endsWith('.class'), `${cls.name} should have .class filename`);
                t.true(cls.size > 0, `${cls.name} should have non-zero size`);
            });
        } else {
            t.fail('metadata.json not found - run npm run generate first');
        }
        
        // Test 5: Verify actual class files exist in dist/data
        const dataDir = path.join(__dirname, '..', 'dist', 'data');
        if (fs.existsSync(dataDir)) {
            const classFiles = fs.readdirSync(dataDir).filter(file => file.endsWith('.class'));
            t.equal(classFiles.length, 25, 'Should have 25 .class files in dist/data directory');
            
            // Check a few specific files
            t.true(classFiles.includes('Hello.class'), 'Should include Hello.class');
            t.true(classFiles.includes('VerySimple.class'), 'Should include VerySimple.class');
            t.true(classFiles.includes('RuntimeArithmetic.class'), 'Should include RuntimeArithmetic.class');
        } else {
            t.fail('dist/data directory not found - run npm run generate first');
        }
        
        // Test 6: Verify browser-ui-enhancements.js has all 25 classes in fallback
        const uiEnhancementsPath = path.join(__dirname, '..', 'src', 'browser-ui-enhancements.js');
        const uiContent = fs.readFileSync(uiEnhancementsPath, 'utf8');
        
        // Count the number of classes in the fallback array
        const fallbackMatch = uiContent.match(/\{\s*filename:\s*'[^']+\.class'/g);
        if (fallbackMatch) {
            t.equal(fallbackMatch.length, 25, 'browser-ui-enhancements.js should have 25 classes in fallback');
        } else {
            t.fail('Could not find fallback class list in browser-ui-enhancements.js');
        }
        
        // Test 7: Verify getClassDescription function has entries for all classes
        const getClassDescMatch = uiContent.match(/getClassDescription\([\s\S]*?\}/);
        if (getClassDescMatch) {
            const descriptionContent = getClassDescMatch[0];
            const expectedClasses = [
                'ArithmeticTest.class', 'Calc.class', 'CalcMain.class', 'Calculator.class', 'ConstantsTest.class',
                'DivisionTest.class', 'ExceptionTest.class', 'Hello.class', 'InvokeVirtualTest.class', 'MainApp.class',
                'RuntimeArithmetic.class', 'SimpleArithmetic.class', 'SimpleStringConcat.class', 'SipushTest.class',
                'SmallDivisionTest.class', 'StringBuilderConcat.class', 'StringConcat.class', 'StringConcatMethod.class',
                'StringMethodsTest.class', 'TestMethods.class', 'TestMethodsRunner.class', 'Thing.class', 'ThingProducer.class',
                'VerySimple.class', 'WorkingArithmetic.class'
            ];
            
            expectedClasses.forEach(className => {
                t.true(descriptionContent.includes(`'${className}'`), `getClassDescription should include ${className}`);
            });
        } else {
            t.fail('Could not find getClassDescription function in browser-ui-enhancements.js');
        }
        
        t.pass('All sample class selection functionality tests passed');
        
    } catch (error) {
        t.fail(`Test failed with error: ${error.message}`);
    }
    
    t.end();
});