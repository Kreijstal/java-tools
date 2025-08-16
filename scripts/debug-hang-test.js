const DebugController = require('../src/debugController');

async function main() {
  const debugController = new DebugController();

  console.log("Starting the debug hang test...");

  try {
    console.log("Calling debugController.start()...");
    await debugController.start('sources/VerySimple.class');
    console.log("debugController.start() completed.");

  } catch (error) {
    console.error("Test failed:", error);
  }
}

main();
