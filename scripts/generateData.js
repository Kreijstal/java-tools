const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function generateSampleData() {
  console.log('Generating sample data...');
  
  // Create a data.zip file with sample class files and documentation
  const output = fs.createWriteStream('data.zip');
  const archive = archiver('zip', { zlib: { level: 9 } });
  
  output.on('close', () => {
    console.log(`Created data.zip (${archive.pointer()} bytes)`);
  });
  
  archive.on('error', (err) => {
    throw err;
  });
  
  archive.pipe(output);
  
  // Add class files
  const classFiles = fs.readdirSync('sources').filter(file => file.endsWith('.class'));
  for (const classFile of classFiles) {
    archive.file(`sources/${classFile}`, { name: `classes/${classFile}` });
  }
  
  // Add Java source files
  const javaFiles = fs.readdirSync('sources').filter(file => file.endsWith('.java'));
  for (const javaFile of javaFiles) {
    archive.file(`sources/${javaFile}`, { name: `java-sources/${javaFile}` });
  }
  
  // Add documentation
  archive.append('Sample Java class files and sources for JVM showcase', { name: 'README.txt' });
  
  // Create sample data JSON
  const sampleData = {
    classes: classFiles.map(file => ({
      name: file.replace('.class', ''),
      file: file,
      hasSource: javaFiles.includes(file.replace('.class', '.java'))
    })),
    features: [
      'Step-by-step execution',
      'Stack visualization',
      'Local variables inspection',
      'Bytecode instruction display',
      'Source code mapping'
    ],
    instructions: [
      'Upload a .class file using the file input',
      'Or select from the sample classes provided',
      'Click "Load Class" to parse the bytecode',
      'Use "Step" to execute one instruction at a time',
      'Watch the stack and variables change in real-time'
    ]
  };
  
  archive.append(JSON.stringify(sampleData, null, 2), { name: 'data.json' });
  
  archive.finalize();
}

// Check if archiver is available, if not, create a simple fallback
try {
  require('archiver');
  generateSampleData();
} catch (e) {
  console.log('Archiver not available, creating simple data file...');
  const classFiles = fs.readdirSync('sources').filter(file => file.endsWith('.class'));
  const javaFiles = fs.readdirSync('sources').filter(file => file.endsWith('.java'));
  
  const sampleData = {
    classes: classFiles.map(file => ({
      name: file.replace('.class', ''),
      file: file,
      hasSource: javaFiles.includes(file.replace('.class', '.java'))
    })),
    timestamp: new Date().toISOString()
  };
  
  fs.writeFileSync('data.json', JSON.stringify(sampleData, null, 2));
  console.log('Created data.json');
}