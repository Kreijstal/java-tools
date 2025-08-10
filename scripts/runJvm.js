const { JVM } = require('../src/jvm');

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/runJvm.js <classFilePath>');
    process.exit(1);
  }

  const classFilePath = args[0];
  const jvm = new JVM();
  jvm.run(classFilePath);
}

main();