const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');

async function main() {
    const tempDir = path.join(__dirname, '../test/temp_manual_rename');
    const sourcesDir = path.join(__dirname, '../sources');

    try {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        fs.mkdirSync(tempDir);

        fs.copyFileSync(path.join(sourcesDir, 'ClassToRename.java'), path.join(tempDir, 'ClassToRename.java'));
        fs.copyFileSync(path.join(sourcesDir, 'ClassRenamingTestRunner.java'), path.join(tempDir, 'ClassRenamingTestRunner.java'));

        execSync(`javac ${path.join(tempDir, '*.java')}`);

        const workspace = await KrakatauWorkspace.create(tempDir);
        await workspace.applyClassRenameAndSave('ClassToRename', 'RenamedClass', tempDir);

        console.log("Manual rename operation complete. Inspect the files in 'test/temp_manual_rename'");

    } catch (error) {
        console.error("Manual rename failed:", error);
    }
}

main();
