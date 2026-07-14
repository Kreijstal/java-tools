const fs = require('fs');
const path = require('path');


function makeFile(filePath) {
  return { type: 'java/io/File', path: filePath };
}

function makeFileArray(files) {
  files.type = '[Ljava/io/File;';
  files.elementType = 'java/io/File';
  return files;
}

function stringValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/io/Serializable'],
  staticFields: {
    'separator:Ljava/lang/String;': path.sep,
    'pathSeparator:Ljava/lang/String;': path.delimiter,
    'separatorChar:C': path.sep.charCodeAt(0),
    'pathSeparatorChar:C': path.delimiter.charCodeAt(0),
  },
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.path = stringValue(args[0]);
    },
    
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (jvm, obj, args) => {
      const parent = args[0];
      const child = args[1];
      
      const parentPath = stringValue(parent);
      const childPath = stringValue(child);
      
      if (parentPath) {
        obj.path = path.join(parentPath, childPath);
      } else {
        obj.path = childPath;
      }
    },
    
    '<init>(Ljava/io/File;Ljava/lang/String;)V': (jvm, obj, args) => {
      const parent = args[0];
      const child = args[1];
      
      const parentPath = parent && parent.path ? parent.path : '';
      const childPath = stringValue(child);
      
      if (parentPath) {
        obj.path = path.join(parentPath, childPath);
      } else {
        obj.path = childPath;
      }
    },
    
    'getName()Ljava/lang/String;': (jvm, obj, args) => {
      const name = path.basename(obj.path);
      return jvm.internString(name);
    },
    
    'getPath()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.path);
    },
    
    'getAbsolutePath()Ljava/lang/String;': (jvm, obj, args) => {
      const absolutePath = path.resolve(obj.path);
      return jvm.internString(absolutePath);
    },

    'getCanonicalPath()Ljava/lang/String;': (jvm, obj) => {
      return jvm.internString(path.resolve(obj.path));
    },
    
    'exists()Z': (jvm, obj, args) => {
      try {
        return fs.existsSync(obj.path);
      } catch (e) {
        return false;
      }
    },
    
    'isFile()Z': (jvm, obj, args) => {
      try {
        const stats = fs.statSync(obj.path);
        return stats.isFile();
      } catch (e) {
        return false;
      }
    },
    
    'isDirectory()Z': (jvm, obj, args) => {
      try {
        const stats = fs.statSync(obj.path);
        return stats.isDirectory();
      } catch (e) {
        return false;
      }
    },
    
    'length()J': (jvm, obj, args) => {
      try {
        const stats = fs.statSync(obj.path);
        return BigInt(stats.size);
      } catch (e) {
        return BigInt(0);
      }
    },
    
    'delete()Z': (jvm, obj, args) => {
      try {
        fs.unlinkSync(obj.path);
        return true;
      } catch (e) {
        return false;
      }
    },
    
    'mkdir()Z': (jvm, obj, args) => {
      try {
        fs.mkdirSync(obj.path);
        return true;
      } catch (e) {
        return false;
      }
    },

    'mkdirs()Z': (jvm, obj, args) => {
      try {
        fs.mkdirSync(obj.path, { recursive: true });
        return true;
      } catch (e) {
        return false;
      }
    },

    'canRead()Z': (jvm, obj, args) => {
      try {
        fs.accessSync(obj.path, fs.constants.R_OK);
        return 1;
      } catch (e) {
        return 0;
      }
    },

    'getParent()Ljava/lang/String;': (jvm, obj, args) => {
      const parent = path.dirname(obj.path);
      return parent && parent !== obj.path ? jvm.internString(parent) : null;
    },

    'getParentFile()Ljava/io/File;': (jvm, obj, args) => {
      const parent = path.dirname(obj.path);
      return parent && parent !== obj.path ? makeFile(parent) : null;
    },

    'list()[Ljava/lang/String;': (jvm, obj, args) => {
      try {
        const entries = fs.readdirSync(obj.path).map((entry) => jvm.internString(entry));
        entries.type = '[Ljava/lang/String;';
        entries.elementType = 'java/lang/String';
        return entries;
      } catch (e) {
        return null;
      }
    },

    'listFiles()[Ljava/io/File;': (jvm, obj, args) => {
      try {
        return makeFileArray(fs.readdirSync(obj.path).map((entry) => makeFile(path.join(obj.path, entry))));
      } catch (e) {
        return null;
      }
    },
    
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.path);
    }
  }
};
