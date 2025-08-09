#!/usr/bin/env node

/**
 * Detailed comparison script between create_java_asm.js and javap
 * This script analyzes differences and helps identify potential parser issues
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { parseClassFile } = require('../src/create_java_asm');

/**
 * Runs javap on a class file and returns the output
 * @param {string} classPath - Path to the .class file
 * @returns {Promise<string>} javap output
 */
function runJavap(classPath) {
  return new Promise((resolve, reject) => {
    exec(`javap -c -v "${classPath}"`, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Extracts key information from both outputs for comparison
 * @param {string} ourOutput - Output from our parser
 * @param {string} javapOutput - Output from javap
 * @returns {Object} Comparison analysis
 */
function analyzeOutputs(ourOutput, javapOutput, className) {
  const analysis = {
    className,
    ourParser: {
      hasClass: ourOutput.includes('.class'),
      hasMethods: ourOutput.includes('.method'),
      hasCode: ourOutput.includes('.code'),
      hasInstructions: /L\d+:/.test(ourOutput),
      instructionCount: (ourOutput.match(/L\d+:/g) || []).length
    },
    javap: {
      hasClass: javapOutput.includes(`class ${className}`) || javapOutput.includes(`public class ${className}`),
      hasMethods: javapOutput.includes('Code:'),
      hasCode: javapOutput.includes('Code:'),
      hasInstructions: /\d+:\s+\w+/.test(javapOutput),
      instructionCount: (javapOutput.match(/\d+:\s+\w+/g) || []).length
    },
    differences: []
  };

  // Check for structural differences
  if (analysis.ourParser.hasClass !== analysis.javap.hasClass) {
    analysis.differences.push('Class declaration format differs');
  }
  
  if (Math.abs(analysis.ourParser.instructionCount - analysis.javap.instructionCount) > 2) {
    analysis.differences.push(`Instruction count differs: ours=${analysis.ourParser.instructionCount}, javap=${analysis.javap.instructionCount}`);
  }

  return analysis;
}

/**
 * Main comparison function
 */
async function compareWithJavap() {
  const sourcesDir = path.join(__dirname, '../sources');
  const classFiles = fs.readdirSync(sourcesDir)
    .filter(file => file.endsWith('.class'))
    .slice(0, 5); // Limit to first 5 files for detailed analysis

  console.log('=== Java Class Parser Comparison: create_java_asm.js vs javap ===\n');

  for (const fileName of classFiles) {
    const classPath = path.join(sourcesDir, fileName);
    const className = path.basename(fileName, '.class');
    
    console.log(`\n--- Analyzing ${fileName} ---`);
    
    try {
      // Get our parser output
      const ourOutput = parseClassFile(classPath);
      
      // Get javap output
      const javapOutput = await runJavap(classPath);
      
      // Perform analysis
      const analysis = analyzeOutputs(ourOutput, javapOutput, className);
      
      console.log(`✓ Both parsers processed ${className} successfully`);
      console.log(`  Our parser: ${analysis.ourParser.instructionCount} instructions`);
      console.log(`  javap: ${analysis.javap.instructionCount} instructions`);
      
      if (analysis.differences.length > 0) {
        console.log(`  Differences found:`);
        analysis.differences.forEach(diff => console.log(`    - ${diff}`));
      } else {
        console.log(`  ✓ No significant structural differences detected`);
      }

      // Save detailed outputs for manual inspection
      const outputDir = '/tmp/parser_comparison';
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      fs.writeFileSync(path.join(outputDir, `${className}_our.asm`), ourOutput);
      fs.writeFileSync(path.join(outputDir, `${className}_javap.asm`), javapOutput);
      
    } catch (error) {
      console.error(`✗ Error processing ${fileName}:`, error.message);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Detailed output files saved to /tmp/parser_comparison/`);
  console.log(`Run 'diff /tmp/parser_comparison/ClassName_our.asm /tmp/parser_comparison/ClassName_javap.asm' for line-by-line comparison`);
  
  // Test a specific case with string operations
  console.log(`\n--- Special Analysis: String Operations ---`);
  const stringFiles = ['StringMethodsTest.class', 'SimpleStringConcat.class'].filter(file => 
    fs.existsSync(path.join(sourcesDir, file))
  );
  
  for (const fileName of stringFiles) {
    const classPath = path.join(sourcesDir, fileName);
    const className = path.basename(fileName, '.class');
    
    try {
      const ourOutput = parseClassFile(classPath);
      const javapOutput = await runJavap(classPath);
      
      const ourInvokes = (ourOutput.match(/invoke\w+/g) || []).length;
      const javapInvokes = (javapOutput.match(/invoke\w+/g) || []).length;
      
      console.log(`${className}:`);
      console.log(`  Our parser found ${ourInvokes} method invocations`);
      console.log(`  javap found ${javapInvokes} method invocations`);
      
      if (ourInvokes === javapInvokes) {
        console.log(`  ✓ Method invocation counts match`);
      } else {
        console.log(`  ⚠ Method invocation counts differ`);
      }
    } catch (error) {
      console.error(`Error analyzing ${fileName}:`, error.message);
    }
  }
}

// Run the comparison if this script is executed directly
if (require.main === module) {
  compareWithJavap().catch(console.error);
}

module.exports = { compareWithJavap, analyzeOutputs };