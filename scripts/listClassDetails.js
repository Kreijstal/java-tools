const { loadClassByPath } = require('../src/classLoader');
const { parseDescriptor } = require('../src/typeParser');

function listClassDetails(classFilePath) {
  const classData = loadClassByPath(classFilePath);
  console.log('Loaded class data:', classData);
  if (!classData) {
    console.error(`Failed to load class from file: ${classFilePath}`);
    process.exit(1);
  }

  const classDetails = {
    className: classData.className,
    fields: [],
    methods: {
      public: [],
      private: []
    }
  };

  console.log('Class data items:', classData.items);
  classData.items.forEach(item => {
    if (item.type === 'field') {
      classDetails.fields.push({
        name: item.field.name,
        descriptor: item.field.descriptor
      });
    } else if (item.type === 'method') {
      const methodDetails = {
        name: item.method.name,
        descriptor: item.method.descriptor
      };
      const flags = parseDescriptor(item.method.descriptor).flags;
      if (flags.includes('public')) {
        classDetails.methods.public.push(methodDetails);
      } else if (flags.includes('private')) {
        classDetails.methods.private.push(methodDetails);
      }
    }
  });

  console.log(JSON.stringify(classDetails, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node listClassDetails.js <classFilePath>');
    process.exit(1);
  }

  const classFilePath = args[0];
  listClassDetails(classFilePath);
}

main();
