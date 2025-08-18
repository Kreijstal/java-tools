const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');

async function main() {
    const classPath = process.argv[2];
    const startClass = process.argv[3];

    if (!classPath || !startClass) {
        console.error('Usage: node scripts/listRefereeInheritance.js <classpath> <startClass>');
        process.exit(1);
    }

    try {
        const workspace = await KrakatauWorkspace.create(classPath);
        const referenceObj = workspace.referenceObj;

        // Stage 1: Find all recursive referees of startClass
        const reverseRefGraph = new Map();
        for (const [referenced, refInfo] of Object.entries(referenceObj)) {
            const addReverseEdge = (referencer, referenced) => {
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

        const refereeSet = new Set([startClass]);
        const worklist = [startClass];
        const visited = new Set([startClass]);

        while(worklist.length > 0) {
            const current = worklist.shift();

            const referencers = reverseRefGraph.get(current) || new Set();
            for (const referencer of referencers) {
                if (!visited.has(referencer)) {
                    visited.add(referencer);
                    refereeSet.add(referencer);
                    worklist.push(referencer);
                }
            }
        }

        // Stage 2: Build and print the inheritance hierarchy for the referee set
        const hierarchy = new Map();
        for (const className of refereeSet) {
            const classDef = workspace.listClasses().find(c => c.identifier.className === className);
            if (classDef) {
                hierarchy.set(className, { ...classDef, children: [] });
            }
        }

        const roots = [];
        for (const className of refereeSet) {
            const ast = workspace.getClassAST(className);
            if (!ast) continue;

            const superClassName = ast.classes[0].superClassName;

            if (superClassName && refereeSet.has(superClassName)) {
                const superClassNode = hierarchy.get(superClassName);
                if (superClassNode) {
                    superClassNode.children.push(hierarchy.get(className));
                }
            } else {
                if(hierarchy.has(className)) {
                    roots.push(hierarchy.get(className));
                }
            }
        }

        function printInheritanceTree(node, prefix) {
            const children = node.children || [];
            children.forEach((child, index) => {
                const isLast = index === children.length - 1;
                console.log(prefix + (isLast ? '└── ' : '├── ') + child.identifier.className);
                printInheritanceTree(child, prefix + (isLast ? '    ' : '│   '));
            });
        }

        roots.forEach((root) => {
            if (root) {
                console.log(root.identifier.className);
                printInheritanceTree(root, '');
            }
        });

    } catch (error) {
        console.error('Error building referee inheritance graph:', error);
    }
}

main();
