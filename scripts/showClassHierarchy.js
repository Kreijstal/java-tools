const path = require('path');
const fs = require('fs');
const { loadClassByPathSync } = require('../src/classLoader');

function getClassInfo(className) {
  // First, check for a .class file in the sources directory
  const classFilePath = path.join('sources', `${className}.class`);
  if (fs.existsSync(classFilePath)) {
    const classData = loadClassByPathSync(classFilePath);
    if (classData && classData.classes && classData.classes.length > 0) {
      return classData.classes[0];
    }
  }

  // If not found, check for a .js file in the JRE implementation
  const jreFilePath = path.join(__dirname, '..', 'src', 'jre', `${className}.js`);
  if (fs.existsSync(jreFilePath)) {
    const jreClass = require(jreFilePath);
    return {
      className: className,
      superClassName: jreClass.super
    };
  }

  return null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/showClassHierarchy.js <classPath>');
    process.exit(1);
  }

  const classPath = args[0];
  const paths = classPath.split(path.delimiter);
  const allClasses = [];

  paths.forEach(p => {
    if (fs.existsSync(p) && fs.lstatSync(p).isDirectory()) {
      fs.readdirSync(p).forEach(file => {
        if (file.endsWith('.class')) {
          const fullPath = path.join(p, file);
          const classData = loadClassByPathSync(fullPath);
          if (classData && classData.classes && classData.classes.length > 0) {
            allClasses.push(classData.classes[0]);
          }
        }
      });
    }
  });

  const classMap = new Map();

  // First pass: populate the map with all classes found
  allClasses.forEach(classInfo => {
    classMap.set(classInfo.className, { ...classInfo, children: [] });
  });

  // Second pass: ensure all superclasses are in the map
  classMap.forEach(classInfo => {
    let parentName = classInfo.superClassName;
    while (parentName && !classMap.has(parentName)) {
      const parentInfoData = getClassInfo(parentName);
      if (parentInfoData) {
        classMap.set(parentName, { ...parentInfoData, children: [] });
        parentName = parentInfoData.superClassName;
      } else {
        break; // No more parents found
      }
    }
  });

  // Third pass: build the children arrays
  classMap.forEach(classInfo => {
    if (classInfo.superClassName) {
      const parentInfo = classMap.get(classInfo.superClassName);
      if (parentInfo) {
        parentInfo.children.push(classInfo);
      }
    }
  });

  function printTree(className, level = 0) {
    const classInfo = classMap.get(className);
    if (!classInfo) {
      console.log(`${'  '.repeat(level)}${className}`);
      return;
    }

    console.log(`${'  '.repeat(level)}${classInfo.className}`);
    classInfo.children.forEach(child => {
      printTree(child.className, level + 1);
    });
  }

  // Find root nodes (classes with no superclass or whose superclass is not in our map)
  const rootNodes = [];
  classMap.forEach(classInfo => {
    if (!classInfo.superClassName || !classMap.has(classInfo.superClassName)) {
      rootNodes.push(classInfo.className);
    }
  });

  rootNodes.forEach(rootNode => printTree(rootNode));
}

main();
