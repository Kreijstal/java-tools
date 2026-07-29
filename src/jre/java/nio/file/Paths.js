const path = require('path');

function stringValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}

function makePath(value) {
  return {
    type: 'java/nio/file/Path',
    path: value,
  };
}

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'get(Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;': (jvm, obj, args) => {
      const first = stringValue(args[0]);
      const more = Array.from(args[1] || [], stringValue);
      return makePath(more.length === 0 ? first : path.join(first, ...more));
    },
  },
};
