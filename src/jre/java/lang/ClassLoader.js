const { withThrows } = require('../../helpers');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const runtimeModuleCache = new Map();

function javaString(value) {
  if (value && value.type === 'java/lang/String' &&
      Object.prototype.hasOwnProperty.call(value, 'value')) {
    return String(value.value);
  }
  return String(value);
}

function byteArrayInputStream(bytes) {
  const array = Array.from(bytes, (value) => value > 127 ? value - 256 : value);
  array.type = '[B';
  return {
    type: 'java/io/ByteArrayInputStream',
    buf: array,
    pos: 0,
    mark: 0,
    count: array.length,
  };
}

async function zipResource(jvm, archivePath, resource, prefix = '') {
  const resolved = path.resolve(archivePath);
  let zip = jvm.jarCache.get(resolved) || runtimeModuleCache.get(resolved);
  if (!zip) {
    let bytes = await fs.promises.readFile(resolved);
    if (resolved.endsWith('.jmod') && bytes[0] === 0x4a && bytes[1] === 0x4d) {
      bytes = bytes.subarray(4);
    }
    zip = await JSZip.loadAsync(bytes);
    if (resolved.endsWith('.jmod')) runtimeModuleCache.set(resolved, zip);
    else jvm.jarCache.set(resolved, zip);
  }
  const entry = zip.file(prefix + resource);
  return entry ? entry.async('uint8array') : null;
}

async function classpathResource(jvm, resource) {
  for (const classpathEntry of jvm.classpath || []) {
    const lower = String(classpathEntry).toLowerCase();
    if (lower.endsWith('.jar') || lower.endsWith('.zip')) {
      const bytes = await zipResource(jvm, classpathEntry, resource);
      if (bytes) return bytes;
    } else {
      const file = path.join(classpathEntry, resource);
      try {
        return await fs.promises.readFile(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  const homes = [];
  if (process.env.JVMJS_JAVA_HOME) {
    homes.push(process.env.JVMJS_JAVA_HOME);
  } else {
    if (process.env.JAVA_HOME) homes.push(process.env.JAVA_HOME);
    try {
      for (const name of fs.readdirSync('/usr/lib/jvm')) {
        homes.push(path.join('/usr/lib/jvm', name));
      }
    } catch (_) {
      // No conventional local JDK installation.
    }
  }
  for (const home of [...new Set(homes)]) {
    const rtJar = path.join(home, 'lib', 'rt.jar');
    try {
      if (fs.statSync(rtJar).isFile()) {
        const bytes = await zipResource(jvm, rtJar, resource);
        if (bytes) return bytes;
      }
    } catch (_) {
      // Modular JDKs do not contain rt.jar.
    }
    const modules = path.join(home, 'jmods');
    let files;
    try {
      files = fs.readdirSync(modules).filter((name) => name.endsWith('.jmod'));
    } catch (_) {
      continue;
    }
    files.sort((a, b) => (a === 'java.base.jmod' ? -1 : b === 'java.base.jmod' ? 1 : a.localeCompare(b)));
    for (const file of files) {
      const bytes = await zipResource(
        jvm,
        path.join(modules, file),
        resource,
        'classes/',
      );
      if (bytes) return bytes;
    }
  }
  return null;
}

module.exports = {
  super: {
    type: 'java/lang/Object'
  },
  staticMethods: {
    'getSystemClassLoader()Ljava/lang/ClassLoader;': (jvm) => jvm.systemClassLoader,
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
    'getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;': async (jvm, obj, args) => {
      const bytes = await classpathResource(jvm, javaString(args[0]));
      return bytes ? byteArrayInputStream(bytes) : null;
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
    'getSystemClassLoader()Ljava/lang/ClassLoader;': (jvm) => jvm.systemClassLoader,
    'getSystemResources(Ljava/lang/String;)Ljava/util/Enumeration;': () => ({
      type: 'java/util/Enumeration',
      array: [],
      index: 0,
    }),
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
