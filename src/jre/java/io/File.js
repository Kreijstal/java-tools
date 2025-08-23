const fs = require('fs');
const path = require('path');

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/io/Serializable'],
  staticFields: {
    'separator:Ljava/lang/String;': {
      get: (jvm) => jvm.internString(path.sep)
    },
    'pathSeparator:Ljava/lang/String;': {
      get: (jvm) => jvm.internString(path.delimiter)
    }
  },
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const pathname = args[0];
      obj.path = pathname && pathname.value ? pathname.value : '';
    },
    
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (jvm, obj, args) => {
      const parent = args[0];
      const child = args[1];
      
      const parentPath = parent && parent.value ? parent.value : '';
      const childPath = child && child.value ? child.value : '';
      
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
      const childPath = child && child.value ? child.value : '';
      
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
        return stats.size;
      } catch (e) {
        return 0;
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
    
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.path);
    }
  }
};