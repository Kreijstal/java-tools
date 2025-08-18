const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');

async function main() {
    const classPath = process.argv[2];
    if (!classPath) {
        console.error('Usage: node scripts/listClassReferenceGraph.js <classpath>');
        process.exit(1);
    }
    console.log(`Initializing workspace for classpath: ${classPath}`);

    try {
        const workspace = await KrakatauWorkspace.create(classPath);
        const referenceObj = workspace.referenceObj;

        console.log('\n--- Class Reference Graph ---');

        for (const [className, classRef] of Object.entries(referenceObj)) {
            console.log(`\n[Referenced Class] ${className}`);

            if (classRef.referees && classRef.referees.length > 0) {
                console.log(`  - Class is referenced by:`);
                classRef.referees.forEach(ref => {
                    console.log(`    - ${ref.className} (at ${ref.astPath})`);
                });
            }

            if (classRef.children && classRef.children.size > 0) {
                console.log('  - Members referenced:');
                for (const [memberName, memberRef] of classRef.children.entries()) {
                    console.log(`    - Member: ${memberName} (${memberRef.descriptor})`);
                    if (memberRef.referees && memberRef.referees.length > 0) {
                        console.log(`      - Referenced by:`);
                        memberRef.referees.forEach(ref => {
                            console.log(`        - ${ref.className} (at ${ref.astPath})`);
                        });
                    }
                }
            }
        }
        console.log('\n--- End of Graph ---');

    } catch (error) {
        console.error('Error listing class reference graph:', error);
    }
}

main();
