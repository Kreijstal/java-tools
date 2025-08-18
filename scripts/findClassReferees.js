const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');

async function main() {
    const classPath = process.argv[2];
    const startClass = process.argv[3];

    if (!classPath || !startClass) {
        console.error('Usage: node scripts/findClassReferees.js <classpath> <startClass>');
        process.exit(1);
    }

    console.log(`Initializing workspace for classpath: ${classPath}`);
    console.log(`Finding all referees for class: ${startClass}`);

    try {
        const workspace = await KrakatauWorkspace.create(classPath);
        const referenceObj = workspace.referenceObj;

        // Build a reverse reference graph (referenced -> set of referencers)
        const reverseRefGraph = new Map();
        for (const [referenced, refInfo] of Object.entries(referenceObj)) {
            const addReverseEdge = (referencer, referenced) => {
                if (referencer === referenced) {
                    return; // Ignore self-references
                }
                if (!reverseRefGraph.has(referenced)) {
                    reverseRefGraph.set(referenced, new Set());
                }
                reverseRefGraph.get(referenced).add(referencer);
            };

            if (refInfo.referees) {
                refInfo.referees.forEach(r => addReverseEdge(r.className, referenced));
            }
            if (refInfo.children) {
                for (const memberRef of refInfo.children.values()) {
                    if (memberRef.referees) {
                        memberRef.referees.forEach(r => addReverseEdge(r.className, referenced));
                    }
                }
            }
        }

        function printRefereeTree(node, visited, prefix = "") {
            const pathVisited = new Set(visited);
            if (pathVisited.has(node)) {
                console.log(prefix + "└── " + node + " (circular reference)");
                return;
            }
            pathVisited.add(node);

            const referencers = reverseRefGraph.get(node) || new Set();
            const referencersArray = Array.from(referencers);

            referencersArray.forEach((referencer, index) => {
                const isLast = index === referencersArray.length - 1;
                console.log(prefix + (isLast ? "└── " : "├── ") + referencer);
                printRefereeTree(referencer, pathVisited, prefix + (isLast ? "    " : "│   "));
            });
        }

        console.log(`\n--- Referee tree for ${startClass} ---`);
        console.log(startClass);
        printRefereeTree(startClass, new Set());
        console.log('\n--- End of Referee Tree ---');

    } catch (error) {
        console.error('Error finding class referees:', error);
    }
}

main();
