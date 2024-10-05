const { loadClass } = require('../src/classLoader');
const { parseDescriptor } = require('../src/typeParser');

function listClassDetails(className, classPath = '.') {
  const classData = loadClass(className, classPath);
  if (!classData) {
    console.error(`Failed to load class: ${className}`);
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
  if (args.length < 1 || args.length > 2) {
    console.error('Usage: node listClassDetails.js <className> [classPath]');
    process.exit(1);
  }

  const className = args[0];
  const classPath = args[1] || '.';
  listClassDetails(className, classPath);
}

main();
