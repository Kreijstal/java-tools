const { loadClassByPath } = require('../src/classLoader');
const { parseDescriptor } = require('../src/typeParser');

async function listClassDetails(classFilePath) {
  const classData = await loadClassByPath(classFilePath);
  // console.log('Loaded class data:', JSON.stringify(classData, null, 2));
  if (!classData) {
    console.error(`Failed to load class from file: ${classFilePath}`);
    process.exit(1);
  }

  const classDetails = {
    className: classData.className,
    fields: [],
    methods: []
  };

  if (classData.classes && classData.classes.length > 0) {
    // console.log('Class data items:', JSON.stringify(classData.classes[0].items, null, 2));
  } else {
    console.log('No classes found in class data.');
  }
  classData.classes[0].items.forEach(item => {
    if (item.type === 'field') {
      classDetails.fields.push({
        name: item.field.name,
        descriptor: item.field.descriptor,
        flags: item.field.flags
      });
    } else if (item.type === 'method') {
      const methodDetails = {
        name: item.method.name,
        descriptor: item.method.descriptor
      };
      methodDetails.flags = item.method.flags;
      classDetails.methods.push(methodDetails);
    }
  });

  console.log(JSON.stringify(classDetails, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node listClassDetails.js <classFilePath>');
    process.exit(1);
  }

  const classFilePath = args[0];
  await listClassDetails(classFilePath);
}

main();
