const { withThrows } = require('../../helpers');

module.exports = {
  super: {
    type: 'java/lang/Object'
  },
  methods: {
    '<init>()V': (jvm, obj, args, thread) => {
      obj.parent = null;
      obj.packages = new Map();
      obj.classes = new Map();
    },
    '<init>(Ljava/lang/ClassLoader;)V': (jvm, obj, args, thread) => {
      obj.parent = args[0];
      obj.packages = new Map();
      obj.classes = new Map();
    },
    'loadClass(Ljava/lang/String;)Ljava/lang/Class;': withThrows((jvm, obj, args, thread) => {
      const name = args[0];

      // Check if the class is already loaded
      const loadedClass = obj.classes.get(name);
      if (loadedClass) {
        return loadedClass;
      }

      // Check parent classloader first (delegation model)
      if (obj.parent) {
        try {
          return obj.parent.methods['loadClass(Ljava/lang/String;)Ljava/lang/Class;'].call(
            null, jvm, obj.parent, [name], thread
          );
        } catch (error) {
          // Parent couldn't load it, continue with current loader
        }
      }

      // Call findClass to try loading the class
      try {
        const foundClass = obj.methods['findClass(Ljava/lang/String;)Ljava/lang/Class;'] ?
          obj.methods['findClass(Ljava/lang/String;)Ljava/lang/Class;'].call(null, jvm, obj, [name], thread) : null;
        if (foundClass) {
          return foundClass;
        }
      } catch (error) {
        // Fall through to throw exception
      }

      // Class not found
      throw {
        type: 'java/lang/ClassNotFoundException',
        message: name
      };
    }, ['java/lang/ClassNotFoundException']),
    'loadClass(Ljava/lang/String;Z)Ljava/lang/Class;': (jvm, obj, args, thread) => {
      const name = args[0];
      const resolve = args[1];

      const loadedClass = obj.methods['loadClass(Ljava/lang/String;)Ljava/lang/Class;'].call(
        null, jvm, obj, [name], thread
      );

      if (resolve) {
        // Call resolveClass if resolution is required
        obj.methods['resolveClass(Ljava/lang/Class;)V'].call(null, jvm, obj, [loadedClass], thread);
      }

      return loadedClass;
    },
    'findClass(Ljava/lang/String;)Ljava/lang/Class;': withThrows((jvm, obj, args, thread) => {
      // Default implementation throws ClassNotFoundException
      // Subclasses should override this method
      throw {
        type: 'java/lang/ClassNotFoundException',
        message: args[0]
      };
    }, ['java/lang/ClassNotFoundException']),
    'defineClass(Ljava/lang/String;[BII)Ljava/lang/Class;': (jvm, obj, args, thread) => {
      const name = args[0];
      const b = args[1];
      const off = args[2];
      const len = args[3];

      // Basic class definition - in a real JVM this would involve bytecode parsing
      // For this mock implementation, we'll create a simple class representation
      const classData = {
        name: name,
        bytecode: b ? b.slice(off, off + len) : null,
        classLoader: obj,
        type: 'java/lang/Class',
        _classData: {
          name: name,
          className: name.replace(/\//g, '.'),
          loader: obj
        }
      };

      // Store the class in this classloader's cache
      obj.classes.set(name, classData);
      return classData;
    },
    'defineClass([BII)Ljava/lang/Class;': (jvm, obj, args, thread) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];

      // Call the other defineClass with null name
      return obj.methods['defineClass(Ljava/lang/String;[BII)Ljava/lang/Class;'].call(
        null, jvm, obj, [null, b, off, len], thread
      );
    },
    'resolveClass(Ljava/lang/Class;)V': (jvm, obj, args, thread) => {
      const cls = args[0];
      // In this simplified implementation, classes are considered resolved immediately
      // In a real JVM, this would involve linking the class and its dependencies
    },
    'getParent()Ljava/lang/ClassLoader;': (jvm, obj, args) => {
      return obj.parent;
    },
    'getResource(Ljava/lang/String;)Ljava/net/URL;': (jvm, obj, args) => {
      const name = args[0];

      // Check parent first
      if (obj.parent) {
        try {
          const parentResource = obj.parent.methods['getResource(Ljava/lang/String;)Ljava/net/URL;'].call(
            null, jvm, obj.parent, [name]
          );
          if (parentResource) {
            return parentResource;
          }
        } catch (error) {
          // Continue with current loader
        }
      }

      // Default implementation - subclasses should override findResource
      return obj.methods['findResource(Ljava/lang/String;)Ljava/net/URL;'] ?
        obj.methods['findResource(Ljava/lang/String;)Ljava/net/URL;'].call(null, jvm, obj, [name]) : null;
    },
    'getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;': (jvm, obj, args) => {
      const name = args[0];
      const url = obj.methods['getResource(Ljava/lang/String;)Ljava/net/URL;'].call(null, jvm, obj, [name]);
      if (url) {
        // In a real implementation, this would create an InputStream from the URL
        // For now, return null as this is mock behavior
        return null;
      }
      return null;
    },
    'findResource(Ljava/lang/String;)Ljava/net/URL;': (jvm, obj, args) => {
      // Default implementation returns null - subclasses should override
      return null;
    },
    'getSystemClassLoader()Ljava/lang/ClassLoader;': (jvm, obj, args) => {
      // Return the system class loader (usually the application class loader)
      return jvm.systemClassLoader;
    }
  },
  staticFields: {},
  staticMethods: {
    'getSystemResource(Ljava/lang/String;)Ljava/net/URL;': (jvm, obj, args) => {
      const systemLoader = module.exports.methods['getSystemClassLoader()Ljava/lang/ClassLoader;'].call(null, jvm, {});
      if (systemLoader) {
        return systemLoader.methods['getResource(Ljava/lang/String;)Ljava/net/URL;'].call(null, jvm, systemLoader, args);
      }
      return null;
    },
    'getSystemResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;': (jvm, obj, args) => {
      const systemLoader = module.exports.methods['getSystemClassLoader()Ljava/lang/ClassLoader;'].call(null, jvm, {});
      if (systemLoader) {
        return systemLoader.methods['getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;'].call(null, jvm, systemLoader, args);
      }
      return null;
    }
  }
};
