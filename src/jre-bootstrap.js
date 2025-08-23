/**
 * JRE Bootstrap Module
 *
 * This module handles the loading and initialization of JRE (Java Runtime Environment) classes
 * into the JVM's runtime class registry. This separates JRE concerns from core JVM functionality.
 */

class JreBootstrap {
  /**
   * Preload essential JRE classes that are required for basic JVM operation
   * @param {JVM} jvm - The JVM instance to load classes into
   */
  static preloadEssentialClasses(jvm) {
    const essentialClasses = [
      'java/lang/Object',
      'java/lang/System',
      'java/lang/String',
      'java/lang/Class',
      'java/io/PrintStream',
      'java/io/ConsoleOutputStream',
      'java/lang/Throwable',
      'java/lang/Exception',
      'java/lang/RuntimeException'
    ];

    for (const className of essentialClasses) {
      if (jvm.jre[className] && !jvm.classes[className]) {
        this.createRuntimeClass(jvm, className, jvm.jre[className]);
      }
    }
  }

  /**
   * Load all JRE classes from the hierarchy and filesystem (extracted from JVM._preloadJreClasses)
   * @param {JVM} jvm - The JVM instance to load classes into
   */
  static preloadAllJreClasses(jvm) {
    const jreHierarchy = {
      "java/lang/Object": null,
      "java/lang/System": "java/lang/Object",
      "java/lang/Throwable": "java/lang/Object",
      "java/lang/Exception": "java/lang/Throwable",
      "java/lang/RuntimeException": "java/lang/Exception",
      "java/lang/ArithmeticException": "java/lang/RuntimeException",
      "java/lang/IllegalArgumentException": "java/lang/RuntimeException",
      "java/lang/IllegalStateException": "java/lang/RuntimeException",
      "java/lang/Enum": "java/lang/Object",
      "java/lang/Runnable": "java/lang/Object",
      "java/lang/CharSequence": "java/lang/Object",
      "java/lang/ReflectiveOperationException": "java/lang/Exception",
      "java/lang/NoSuchMethodException":
        "java/lang/ReflectiveOperationException",
      "java/io/IOException": "java/lang/Exception",
      "java/io/Reader": "java/lang/Object",
      "java/io/BufferedReader": "java/io/Reader",
      "java/io/InputStreamReader": "java/io/Reader",
      "java/io/InputStream": "java/lang/Object",
      "java/io/FilterInputStream": "java/io/InputStream",
      "java/io/BufferedInputStream": "java/io/FilterInputStream",
      "java/io/OutputStream": "java/lang/Object",
      "java/io/FilterOutputStream": "java/io/OutputStream",
      "java/io/PrintStream": "java/io/FilterOutputStream",
      "java/io/ConsoleOutputStream": "java/io/OutputStream",
      "java/net/URLConnection": "java/lang/Object",
      "java/net/HttpURLConnection": "java/net/URLConnection",
      "java/net/URI": "java/lang/Object",
      "java/net/http/HttpClient": "java/lang/Object",
      "java/net/http/HttpRequest": "java/lang/Object",
      "java/net/http/HttpResponse": "java/lang/Object",
      "java/time/Duration": "java/lang/Object",
      "java/util/function/Function": "java/lang/Object",
    };

    // Create stubs for all classes in the hierarchy
    for (const className in jreHierarchy) {
      const superClassName = jreHierarchy[className];
      const jreClassDef = jvm.jre[className];
      const interfaces =
        jreClassDef && jreClassDef.interfaces ? jreClassDef.interfaces : [];

      const classStub = {
        ast: {
          classes: [
            {
              className: className,
              superClassName: superClassName,
              items: [],
              flags: ["public"],
              interfaces: interfaces,
            },
          ],
        },
        constantPool: [],
        staticFields: new Map(),
      };
      jvm.classes[className] = classStub;
    }

    // Add other JRE classes that extend Object directly - only in Node.js environment
    if (typeof window === "undefined" && jvm.fs && jvm.path) {
      const jrePath = jvm.path.join(__dirname, "jre");
      const walk = (dir, prefix) => {
        const files = jvm.fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = jvm.path.join(dir, file);
          const stat = jvm.fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, `${prefix}${file}/`);
          } else if (file.endsWith(".js")) {
            const className = `${prefix}${file.slice(0, -3)}`;
            if (!jvm.classes[className]) {
              const jreClassDef = jvm.jre[className];
              const interfaces =
                jreClassDef && jreClassDef.interfaces
                  ? jreClassDef.interfaces
                  : [];
              const methods =
                jreClassDef && jreClassDef.methods
                  ? Object.keys(jreClassDef.methods).map((methodSig) => {
                      const openParen = methodSig.indexOf("(");
                      const name = methodSig.substring(0, openParen);
                      const descriptor = methodSig.substring(openParen);
                      return {
                        type: "method",
                        method: {
                          name: name,
                          descriptor: descriptor,
                          flags: ["public"], // Assume public for JRE methods
                          attributes: [],
                        },
                      };
                    })
                  : [];

              const classStub = {
                ast: {
                  classes: [
                    {
                      className: className,
                      superClassName:
                        (jreClassDef && jreClassDef.super) ||
                        "java/lang/Object",
                      items: methods,
                      flags: ["public"],
                      interfaces: interfaces,
                    },
                  ],
                },
                constantPool: [],
                staticFields: new Map(),
              };

              // Initialize static fields from JRE definition during preloading
              if (jreClassDef && jreClassDef.staticFields) {
                for (const [fieldKey, fieldValue] of Object.entries(
                  jreClassDef.staticFields,
                )) {
                  classStub.staticFields.set(fieldKey, fieldValue);
                }
              }

              jvm.classes[className] = classStub;
            }
          }
        }
      };
      walk(jrePath, "");
    }
    // In browser environment, we'll rely on the basic hierarchy defined above
    // and any additional JRE classes can be loaded dynamically as needed
  }

  /**
   * Create a runtime class representation from a JRE class definition
   * @param {JVM} jvm - The JVM instance
   * @param {string} className - Name of the class to create
   * @param {Object} jreClassDef - JRE class definition from jre/index.js
   */
  static createRuntimeClass(jvm, className, jreClassDef) {
    const interfaces = jreClassDef && jreClassDef.interfaces ? jreClassDef.interfaces : [];

    // Create method items from JRE class definition (similar to original _preloadJreClasses)
    const methods = [];
    if (jreClassDef) {
      // Add regular methods
      if (jreClassDef.methods) {
        for (const methodSig in jreClassDef.methods) {
          const openParen = methodSig.indexOf("(");
          const name = methodSig.substring(0, openParen);
          const descriptor = methodSig.substring(openParen);
          methods.push({
            type: "method",
            method: {
              name: name,
              descriptor: descriptor,
              flags: ["public"], // Assume public for JRE methods
              attributes: [],
            },
          });
        }
      }
      // Add static methods
      if (jreClassDef.staticMethods) {
        for (const methodSig in jreClassDef.staticMethods) {
          const openParen = methodSig.indexOf("(");
          const name = methodSig.substring(0, openParen);
          const descriptor = methodSig.substring(openParen);
          methods.push({
            type: "method",
            method: {
              name: name,
              descriptor: descriptor,
              flags: ["public", "static"], // Mark as static
              attributes: [],
            },
          });
        }
      }
    }

    const classStub = {
      ast: {
        classes: [
          {
            className: className,
            superClassName: jreClassDef && jreClassDef.super ? jreClassDef.super : "java/lang/Object",
            items: methods,
            flags: ["public"],
            interfaces: interfaces,
          },
        ],
      },
      constantPool: [],
      staticFields: new Map(),
    };

    // Initialize static fields from JRE definition
    if (jreClassDef && jreClassDef.staticFields) {
      if (jvm.verbose) {
        console.log(`Initializing static fields for ${className} from JRE definition`);
      }
      for (const [fieldKey, fieldValue] of Object.entries(jreClassDef.staticFields)) {
        classStub.staticFields.set(fieldKey, fieldValue);
        if (jvm.verbose) {
          console.log(`  Set static field ${fieldKey}:`, fieldValue);
        }
      }
    }

    jvm.classes[className] = classStub;
  }
}

module.exports = { JreBootstrap };