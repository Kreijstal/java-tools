const path = require('path');

function stringValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value.path !== undefined) return String(value.path);
  if (Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}

function makePath(value) {
  return {
    type: 'java/nio/file/Path',
    path: value,
  };
}

function stringHash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash * 31) + value.charCodeAt(i)) | 0;
  }
  return hash;
}

function pathParts(value) {
  const text = stringValue(value);
  if (text === '') return { root: '', elements: [], empty: true };
  const normalized = path.normalize(text);
  const root = path.parse(normalized).root;
  const remainder = normalized.slice(root.length);
  return {
    root,
    elements: remainder === '' ? [] : remainder.split(path.sep).filter(Boolean),
    empty: false,
  };
}

function pathPartEquals(left, right) {
  return path.sep === '\\'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function rootsEqual(left, right) {
  return pathPartEquals(left, right);
}

function elementsEqualAt(left, right, offset) {
  for (let i = 0; i < right.length; i++) {
    if (!pathPartEquals(left[offset + i], right[i])) return false;
  }
  return true;
}

function startsWithPath(value, prefixValue) {
  const valueParts = pathParts(value);
  const prefixParts = pathParts(prefixValue);
  if (valueParts.empty || prefixParts.empty) {
    return valueParts.empty && prefixParts.empty;
  }
  if (Boolean(valueParts.root) !== Boolean(prefixParts.root)) return false;
  if (valueParts.root && !rootsEqual(valueParts.root, prefixParts.root)) return false;
  if (prefixParts.elements.length > valueParts.elements.length) return false;
  return elementsEqualAt(valueParts.elements, prefixParts.elements, 0);
}

function endsWithPath(value, suffixValue) {
  const valueParts = pathParts(value);
  const suffixParts = pathParts(suffixValue);
  if (valueParts.empty || suffixParts.empty) {
    return valueParts.empty && suffixParts.empty;
  }
  if (suffixParts.root) {
    if (!valueParts.root || !rootsEqual(valueParts.root, suffixParts.root)) return false;
    if (valueParts.elements.length !== suffixParts.elements.length) return false;
    return elementsEqualAt(valueParts.elements, suffixParts.elements, 0);
  }
  if (suffixParts.elements.length > valueParts.elements.length) return false;
  return elementsEqualAt(
    valueParts.elements,
    suffixParts.elements,
    valueParts.elements.length - suffixParts.elements.length,
  );
}

module.exports = {
  isInterface: true,
  super: null,
  interfaces: ['java/lang/Comparable', 'java/lang/Iterable', 'java/nio/file/Watchable'],
  methods: {
    'toFile()Ljava/io/File;': (jvm, obj) => ({
      type: 'java/io/File',
      path: obj.path,
    }),
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.path),
    'isAbsolute()Z': (jvm, obj) => path.isAbsolute(obj.path) ? 1 : 0,
    'toAbsolutePath()Ljava/nio/file/Path;': (jvm, obj) => makePath(path.resolve(obj.path)),
    'normalize()Ljava/nio/file/Path;': (jvm, obj) => makePath(path.normalize(obj.path)),
    'getFileName()Ljava/nio/file/Path;': (jvm, obj) => {
      const name = path.basename(obj.path);
      return name ? makePath(name) : null;
    },
    'getParent()Ljava/nio/file/Path;': (jvm, obj) => {
      const parent = path.dirname(obj.path);
      return parent && parent !== obj.path ? makePath(parent) : null;
    },
    'resolve(Ljava/lang/String;)Ljava/nio/file/Path;': (jvm, obj, args) => {
      const other = stringValue(args[0]);
      return makePath(path.isAbsolute(other) ? other : path.join(obj.path, other));
    },
    'resolve(Ljava/nio/file/Path;)Ljava/nio/file/Path;': (jvm, obj, args) => {
      const other = stringValue(args[0]);
      return makePath(path.isAbsolute(other) ? other : path.join(obj.path, other));
    },
    'startsWith(Ljava/nio/file/Path;)Z': (jvm, obj, args) =>
      startsWithPath(obj.path, args[0]) ? 1 : 0,
    'endsWith(Ljava/nio/file/Path;)Z': (jvm, obj, args) =>
      endsWithPath(obj.path, args[0]) ? 1 : 0,
    'compareTo(Ljava/nio/file/Path;)I': (jvm, obj, args) => {
      const other = stringValue(args[0]);
      return obj.path < other ? -1 : (obj.path > other ? 1 : 0);
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) =>
      args[0] && args[0].path !== undefined && obj.path === args[0].path ? 1 : 0,
    'hashCode()I': (jvm, obj) => stringHash(obj.path),
  },
};
