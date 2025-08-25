const fs = require('fs');
const path = require('path');

console.log('--- Debugging File System Access ---');

const filePath = 'test.tmp';
const absolutePath = path.resolve(filePath);

console.log(`Current working directory: ${process.cwd()}`);
console.log(`Attempting to create file at: ${absolutePath}`);

try {
    fs.writeFileSync(filePath, 'Hello from debug script');
    console.log('File created successfully.');

    const content = fs.readFileSync(filePath, 'utf8');
    console.log(`File content: ${content}`);

    fs.unlinkSync(filePath);
    console.log('File deleted successfully.');
} catch (e) {
    console.error('File system operation failed:', e);
}

console.log('--- Debug script finished ---');
