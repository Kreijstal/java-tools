const test = require('tape');
const DebugController = require('../src/debugController');

test('DebugController getDisassemblyView functionality', async (t) => {
    const debugController = new DebugController();
    
    // Test initial state (no class loaded)
    const initialView = debugController.getDisassemblyView();
    t.ok(initialView, 'getDisassemblyView should return an object');
    t.equal(initialView.formattedDisassembly, '', 'Initial formattedDisassembly should be empty');
    t.deepEqual(initialView.lineToPcMap, {}, 'Initial lineToPcMap should be empty');
    t.equal(initialView.classFile, null, 'Initial classFile should be null');
    t.equal(initialView.currentPc, -1, 'Initial currentPc should be -1');
    
    // Test with a loaded class
    try {
        await debugController.start('sources/VerySimple.class');
        
        const view = debugController.getDisassemblyView();
        t.ok(view, 'getDisassemblyView should return an object after starting debug session');
        t.ok(view.formattedDisassembly, 'formattedDisassembly should not be empty');
        t.ok(typeof view.formattedDisassembly === 'string', 'formattedDisassembly should be a string');
        t.ok(view.lineToPcMap, 'lineToPcMap should exist');
        t.ok(typeof view.lineToPcMap === 'object', 'lineToPcMap should be an object');
        t.ok(view.classFile, 'classFile should not be null');
        t.ok(view.classFile.endsWith('.class'), 'classFile should end with .class');
        t.ok(typeof view.currentPc === 'number', 'currentPc should be a number');
        
        // Check that the formatted disassembly contains expected debug header
        t.ok(view.formattedDisassembly.includes('8. Disassembly View'), 'Should contain debug header');
        t.ok(view.formattedDisassembly.includes('File:'), 'Should contain file information');
        t.ok(view.formattedDisassembly.includes('Current PC:'), 'Should contain current PC information');
        
        console.log('Disassembly view sample:');
        console.log(view.formattedDisassembly.split('\n').slice(0, 10).join('\n'));
        
    } catch (error) {
        t.fail(`Failed to start debug session: ${error.message}`);
    }
    
    t.end();
});