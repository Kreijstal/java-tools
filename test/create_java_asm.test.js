/**
 * Test suite for create_java_asm.js functionality
 * Compares our Java class parser output with javap reference output
 */

const test = require('tape');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { parseClassFile } = require('../src/create_java_asm');

// Get all .class files in the sources directory
const sourcesDir = path.join(__dirname, '../sources');
const classFiles = fs.readdirSync(sourcesDir)
  .filter(file => file.endsWith('.class'))
  .map(file => path.join(sourcesDir, file));

test('create_java_asm basic functionality', function (t) {
  t.plan(3);
  
  const helloClassPath = path.join(sourcesDir, 'Hello.class');
  
  // Test that parsing doesn't throw errors
  t.doesNotThrow(() => {
    const result = parseClassFile(helloClassPath);
    t.ok(result.includes('.class public super Hello'), 'Output should contain correct class name');
    t.ok(result.includes('.super java/lang/Object'), 'Output should contain correct superclass name');
  }, 'parseClassFile does not throw for valid class file');
});

test('create_java_asm output format validation', function (t) {
  const helloClassPath = path.join(sourcesDir, 'Hello.class');
  const result = parseClassFile(helloClassPath);
  
  // Check that output contains expected assembly directives
  t.ok(result.includes('.class'), 'Contains .class directive');
  t.ok(result.includes('.method'), 'Contains .method directive');
  t.ok(result.includes('.end class'), 'Contains .end class directive');
  t.ok(result.includes('.super'), 'Contains .super directive');
  
  t.end();
});

test('create_java_asm vs javap comparison', function (t) {
  // Test a few key files to ensure our parser captures essential information
  const testFiles = ['Hello.class', 'SimpleStringConcat.class', 'VerySimple.class'].filter(file => 
    fs.existsSync(path.join(sourcesDir, file))
  );
  
  if (testFiles.length === 0) {
    t.skip('No test class files found');
    return;
  }
  
  t.plan(testFiles.length * 2);
  
  testFiles.forEach(fileName => {
    const classPath = path.join(sourcesDir, fileName);
    
    // Test our parser
    let ourOutput;
    t.doesNotThrow(() => {
      ourOutput = parseClassFile(classPath);
    }, `Our parser successfully parses ${fileName}`);
    
    // Test that javap can also parse it (as a sanity check)
    exec(`javap -c "${classPath}"`, (error, javapOutput, stderr) => {
      if (error) {
        t.fail(`javap failed for ${fileName}: ${error.message}`);
      } else {
        // Basic structural comparison - both should identify the same class
        const className = path.basename(fileName, '.class');
        t.ok(
          ourOutput.includes(className) && javapOutput.includes(className),
          `Both parsers identify class ${className}`
        );
      }
    });
  });
});

test('create_java_asm handles all available class files', function (t) {
  if (classFiles.length === 0) {
    t.skip('No class files found to test');
    return;
  }
  
  t.plan(classFiles.length);
  
  classFiles.forEach(classFile => {
    const fileName = path.basename(classFile);
    t.doesNotThrow(() => {
      parseClassFile(classFile);
    }, `Successfully parses ${fileName}`);
  });
});

test('create_java_asm string method files analysis', function (t) {
  // Test files specifically related to string operations that we added
  const stringTestFiles = [
    'SimpleStringConcat.class',
    'StringConcatMethod.class', 
    'StringConcat.class',
    'StringBuilderConcat.class',
    'StringMethodsTest.class',
    'InvokeVirtualTest.class'
  ].filter(file => fs.existsSync(path.join(sourcesDir, file)));
  
  if (stringTestFiles.length === 0) {
    t.skip('No string test class files found');
    return;
  }
  
  t.plan(stringTestFiles.length * 2);
  
  stringTestFiles.forEach(fileName => {
    const classPath = path.join(sourcesDir, fileName);
    
    let output;
    t.doesNotThrow(() => {
      output = parseClassFile(classPath);
    }, `Successfully parses string test file ${fileName}`);
    
    // Check for invokevirtual instructions in string-related files
    if (output) {
      const hasInvokeVirtual = output.includes('invokevirtual') || 
                              output.includes('invokespecial') ||
                              output.includes('getstatic');
      t.ok(hasInvokeVirtual, `${fileName} contains expected method invocation instructions`);
    } else {
      t.fail(`No output generated for ${fileName}`);
    }
  });
});