const path = require('path');
const { JVM } = require('../src/jvm');

function main() {
  const args = process.argv.slice(2);
  let cp = '.';
  let mainClass = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-cp' || args[i] === '-classpath') {
      if (i + 1 < args.length) {
        cp = args[i + 1];
        i++;
      } else {
        console.error('Error: classpath not specified');
        process.exit(1);
      }
    } else {
      mainClass = args[i];
    }
  }

  if (!mainClass) {
    console.error('Usage: node scripts/runJvm.js [-cp <classpath>] <mainClass>');
    process.exit(1);
  }

  const jvm = new JVM({ classpath: cp.split(':') });
  const classFilePath = jvm.findClassFileSync(mainClass);

  if (!classFilePath) {
    console.error(`Error: Could not find or load main class ${mainClass}`);
    process.exit(1);
  }

  jvm.run(classFilePath);
}

main();