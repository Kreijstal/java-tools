/**
 * Runs Krakatau (krak2) on a class file and returns the disassembly output
 * @param {string} classPath - Path to the .class file
 * @returns {Promise<string>} krak2 output
 */
function runKrak2(classPath) {
  return new Promise((resolve, reject) => {
    const krak2Path = path.resolve(__dirname, '../tools/krakatau/Krakatau/target/release/krak2');
    if (!fs.existsSync(krak2Path)) {
      return reject(new Error(`krak2 binary not found at ${krak2Path}`));
    }
    const outDir = '/tmp/krakatau_disasm';
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    // Krakatau will output a .j file with the same name as the class
    const classBase = path.basename(classPath, '.class');
    const jFile = path.join(outDir, `${classBase}.j`);
    exec(`"${krak2Path}" dis --out "${outDir}" "${classPath}"`, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        // Read the generated .j file
        fs.readFile(jFile, 'utf8', (err, data) => {
          if (err) {
            reject(new Error(`krak2 disassembly succeeded but could not read output: ${jFile}`));
          } else {
            resolve(data);
          }
        });
      }
    });
  });
}

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
  // --- MODIFICATION START ---
  // Get command-line arguments, excluding the first two (node executable and script path)
  const args = process.argv.slice(2);

  // Find the optional --with-javap flag
  const includeJavap = args.includes('--with-javap');
  
  // The first argument that is not a flag is our classpath
  const sourcesDir = args.find(arg => !arg.startsWith('--'));

  // If no classpath is provided, print usage instructions and exit
  if (!sourcesDir) {
    console.error('Error: Please provide a path to the directory containing .class files.');
    console.error('\nUsage: node scripts/compare_with_javap.js <classpath> [--with-javap]');
    console.error('Example: node scripts/compare_with_javap.js ./sources');
    process.exit(1);
  }

  if (!fs.existsSync(sourcesDir)) {
    console.error(`Error: Directory not found at '${sourcesDir}'`);
    process.exit(1);
  }
  // --- MODIFICATION END ---

  const classFiles = fs.readdirSync(sourcesDir)
    .filter(file => file.endsWith('.class'));

  console.log(`=== Java Class Parser Comparison: ours vs krak2${includeJavap ? ' vs javap' : ''} ===\n`);
  console.log(`🔍 Target directory: ${path.resolve(sourcesDir)}\n`);

  for (const fileName of classFiles) {
    const classPath = path.join(sourcesDir, fileName); // Use the provided directory
    const className = path.basename(fileName, '.class');

    console.log(`--- Analyzing ${fileName} ---`);

    try {
      // Get our parser output
      const ourOutput = parseClassFile(classPath);

      // Get krak2 output
      const krak2Output = await runKrak2(classPath);

      let javapOutput = '';
      if (includeJavap) {
        javapOutput = await runJavap(classPath);
      }

      // Save detailed outputs for manual inspection
      const outputDir = '/tmp/parser_comparison';
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(path.join(outputDir, `${className}_our.asm`), ourOutput);
      fs.writeFileSync(path.join(outputDir, `${className}_krak2.asm`), krak2Output);
      if (includeJavap) {
        fs.writeFileSync(path.join(outputDir, `${className}_javap.asm`), javapOutput);
      }

      // Count instructions for krak2: Krakatau .j output labels instructions as L<number>:
      const krak2InstrCount = (krak2Output.match(/L\d+:/g) || []).length;
      if (process.env.KRAK2_DEBUG === '1') {
        console.log(`  [debug] First 5 Krakatau instruction labels:`, (krak2Output.match(/L\d+:/g) || []).slice(0,5));
      }

      const ourInstrCount = (ourOutput.match(/L\d+:/g) || []).length;
      console.log(`✓ Parsed ${className}`);
      console.log(`  Our parser: ${ourInstrCount} instructions`);
      console.log(`  krak2: ${krak2InstrCount} instructions`);
      if (includeJavap) {
        console.log(`  javap: ${((javapOutput.match(/\d+:\s+\w+/g) || []).length)} instructions`);
      }

      // Diff ours vs krak2 instruction lines
      const ourLines = ourOutput.split(/\r?\n/).filter(l => /^L\d+:/.test(l));
      const krak2Lines = krak2Output.split(/\r?\n/).filter(l => /^L\d+:/.test(l));
      const mismatches = [];
      const minLen = Math.min(ourLines.length, krak2Lines.length);
      for (let i = 0; i < minLen && mismatches.length < 10; i++) {
        // Compare ignoring multiple spaces
        const normOur = ourLines[i].replace(/\s+/g,' ').trim();
        const normK = krak2Lines[i].replace(/\s+/g,' ').trim();
        if (normOur !== normK) {
          mismatches.push({ index: i, ours: ourLines[i], krak2: krak2Lines[i] });
        }
      }
      if (ourLines.length !== krak2Lines.length) {
        console.log(`  ⚠ Instruction count mismatch between ours and krak2 (ours=${ourLines.length}, krak2=${krak2Lines.length})`);
      }
      if (mismatches.length) {
        console.log(`  ⚠ ${mismatches.length} differing instruction lines (showing up to 10):`);
        mismatches.forEach(m => {
          console.log(`    [${m.index}] ours:  ${m.ours}`);
          console.log(`        krak2: ${m.krak2}`);
        });
      } else {
        console.log('  ✓ Instruction sequences match between ours and krak2 (first pass)');
      }

      // Save a simple diff file if mismatches
      if (mismatches.length) {
        const diffFile = path.join(outputDir, `${className}_ours_vs_krak2.diff.txt`);
        const diffText = mismatches.map(m => `Index ${m.index}\nOURS : ${m.ours}\nKRAK2: ${m.krak2}\n`).join('\n');
        fs.writeFileSync(diffFile, diffText);
      }

    } catch (error) {
      console.error(`✗ Error processing ${fileName}:`, error.message);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Detailed output files saved to /tmp/parser_comparison/`);
  if (includeJavap) {
    console.log(`Run 'diff /tmp/parser_comparison/ClassName_our.asm /tmp/parser_comparison/ClassName_javap.asm' for line-by-line comparison with javap`);
  }
  
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
      let javapOutput = '';
      if (includeJavap) {
        javapOutput = await runJavap(classPath);
      }
      
      const ourInvokes = (ourOutput.match(/invoke\w+/g) || []).length;
      
      console.log(`${className}:`);
      console.log(`  Our parser found ${ourInvokes} method invocations`);
      if (includeJavap) {
        const javapInvokes = (javapOutput.match(/invoke\w+/g) || []).length;
        console.log(`  javap found ${javapInvokes} method invocations`);
        if (ourInvokes === javapInvokes) {
          console.log(`  ✓ Method invocation counts match (ours vs javap)`);
        } else {
          console.log(`  ⚠ Method invocation counts differ (ours=${ourInvokes}, javap=${javapInvokes})`);
        }
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

module.exports = { compareWithJavap, analyzeOutputs, runKrak2 };