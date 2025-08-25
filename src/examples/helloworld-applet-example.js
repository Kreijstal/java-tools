/**
 * Example demonstrating how to run the HelloWorld applet in the browser
 * This shows the complete workflow: instantiate applet -> initialize -> paint
 */

// Sample usage that would be used in the browser after loading the JVM bundle:
const exampleUsage = `
// 1. Initialize JVM Debug with AWT support
const jvmDebug = new JVMDebug.BrowserJVMDebug();
await jvmDebug.initialize();

// 2. Load HelloWorld class (this is already in the data.zip)
// No need to manually load since it's included in the build

// 3. Create HelloWorld applet instance
const helloWorldObj = { type: 'HelloWorld' };

// 4. Initialize the applet (this creates the canvas and AWT components)
const initMethod = jvmDebug.debugController.jvm._jreFindMethod('HelloWorld', '<init>', '()V');
await initMethod(jvmDebug.debugController.jvm, helloWorldObj, []);

// 5. The applet is now ready! The canvas should be visible in the DOM
// The AWT container with the canvas is automatically created and added to the page

// 6. To trigger a paint operation:
const repaintMethod = jvmDebug.debugController.jvm._jreFindMethod('HelloWorld', 'repaint', '()V');
await repaintMethod(jvmDebug.debugController.jvm, helloWorldObj, []);

// The "Hello World" text should now appear on the canvas at coordinates (20, 20)
`;

console.log('HelloWorld Applet Browser Integration Example:');
console.log(exampleUsage);

module.exports = {
  exampleUsage,
  description: 'This example shows how HelloWorld applet integrates with the browser AWT framework'
};