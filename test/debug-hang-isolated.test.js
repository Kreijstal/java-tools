const test = require('tape');
const DebugController = require('../src/debugController');

test('DebugController hang test', async (t) => {
    const debugController = new DebugController();

    console.log("Attempting to start debug session...");
    try {
        await debugController.start('sources/VerySimple.class');
        console.log("Debug session started.");
        t.pass('debugController.start() did not hang');
    } catch (error) {
        t.fail(`Failed to start debug session: ${error.message}`);
    }

    t.end();
});
