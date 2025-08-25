const test = require('tape');
const { JVM } = require('../src/jvm');

test('HelloWorld Applet - AWT JRE Classes', async (t) => {
  try {
    const jvm = new JVM();
    
    // Test that our JRE classes are loaded
    t.ok(jvm.jre['java/awt/Component'], 'java.awt.Component should be in JRE');
    t.ok(jvm.jre['java/awt/Container'], 'java.awt.Container should be in JRE');
    t.ok(jvm.jre['java/awt/Panel'], 'java.awt.Panel should be in JRE');
    t.ok(jvm.jre['java/awt/Graphics'], 'java.awt.Graphics should be in JRE');
    t.ok(jvm.jre['java/applet/Applet'], 'java.applet.Applet should be in JRE');
    
    // Create AWT objects using proper pattern
    const component = { type: 'java/awt/Component' };
    const container = { type: 'java/awt/Container' };
    const panel = { type: 'java/awt/Panel' };
    const applet = { type: 'java/applet/Applet' };
    const graphics = { type: 'java/awt/Graphics' };
    
    t.ok(component, 'Should be able to create Component object');
    t.ok(container, 'Should be able to create Container object');
    t.ok(panel, 'Should be able to create Panel object');
    t.ok(applet, 'Should be able to create Applet object');
    t.ok(graphics, 'Should be able to create Graphics object');
    
    // Test applet initialization
    const appletInitMethod = jvm._jreFindMethod('java/applet/Applet', '<init>', '()V');
    if (appletInitMethod) {
      await appletInitMethod(jvm, applet, []);
      t.ok(applet._awtComponent, 'Applet should have _awtComponent after initialization');
      
      // Test graphics creation
      const getGraphicsMethod = jvm._jreFindMethod('java/applet/Applet', 'getGraphics', '()Ljava/awt/Graphics;');
      if (getGraphicsMethod) {
        const graphicsResult = await getGraphicsMethod(jvm, applet, []);
        t.ok(graphicsResult, 'Should be able to get graphics from applet');
        
        if (graphicsResult && graphicsResult._awtGraphics) {
          // Test drawString operation
          const drawStringMethod = jvm._jreFindMethod('java/awt/Graphics', 'drawString', '(Ljava/lang/String;II)V');
          if (drawStringMethod) {
            const testString = 'Hello World';
            await drawStringMethod(jvm, graphicsResult, [testString, 20, 20]);
            
            // Check if operation was recorded in MockGraphics
            const awtGraphics = graphicsResult._awtGraphics;
            if (awtGraphics && awtGraphics.operations) {
              t.ok(awtGraphics.operations.length > 0, 'Should have recorded drawing operations');
              
              const drawStringOps = awtGraphics.operations.filter(op => op.includes('drawString'));
              t.ok(drawStringOps.length > 0, 'Should have recorded drawString operation');
              
              const helloWorldOps = awtGraphics.operations.filter(op => 
                op.includes('drawString') && op.includes('Hello World')
              );
              t.ok(helloWorldOps.length > 0, 'Should have drawn "Hello World" text');
              
              console.log('Recorded AWT operations:', awtGraphics.operations);
            }
          }
        }
      }
      
      // Test repaint functionality
      const repaintMethod = jvm._jreFindMethod('java/applet/Applet', 'repaint', '()V');
      if (repaintMethod) {
        await repaintMethod(jvm, applet, []);
        t.pass('Repaint method executed successfully');
      }
    }
    
    t.end();
  } catch (error) {
    console.error('Test error:', error);
    t.fail(`Test failed with error: ${error.message}`);
    t.end();
  }
});