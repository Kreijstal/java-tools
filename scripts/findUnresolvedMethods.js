const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');

async function findUnresolved(classPath) {
  try {
    console.log(`Initializing workspace for path: ${classPath}`);
    const workspace = await KrakatauWorkspace.create(classPath);

    console.log('Finding unresolved methods...');
    const unresolvedMethods = workspace.findUnresolvedMethods();

    if (unresolvedMethods.length === 0) {
      console.log('No unresolved methods found.');
    } else {
      console.log('Unresolved methods found:');
      unresolvedMethods.forEach(method => {
        console.log(`  - ${method.toString()}`);
      });
    }
  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/findUnresolvedMethods.js <classPath>');
    process.exit(1);
  }

  const classPath = args[0];
  findUnresolved(classPath);
}

main();
