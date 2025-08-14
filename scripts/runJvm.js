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

  const classFilePath = path.join(cp, `${mainClass}.class`);
  const jvm = new JVM();

  let stdin = '';
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        stdin += chunk;
      }
    });

    process.stdin.on('end', () => {
      jvm.run(classFilePath, { stdin: stdin });
    });
  } else {
    jvm.run(classFilePath);
  }
}

main();