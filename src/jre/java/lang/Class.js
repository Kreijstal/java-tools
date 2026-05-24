
function classNameFor(classObj) {
  if (!classObj) return null;
  if (classObj.isPrimitive) return classObj.name || null;
  if (classObj._classData && classObj._classData.ast && classObj._classData.ast.classes[0]) {
    return classObj._classData.ast.classes[0].className;
  }
  if (classObj.className) return String(classObj.className).replace(/\./g, '/');
  if (classObj.type && classObj.type !== 'java/lang/Class') return String(classObj.type).replace(/\./g, '/');
  return null;
}

function runtimeClassName(obj) {
  return obj && (obj._className || obj.type);
}
const { withThrows } = require('../../helpers');

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'forName(Ljava/lang/String;)Ljava/lang/Class;': async (jvm, classObj, args) => {
      const classNameWithDots = args[0] && args[0].value !== undefined ? args[0].value : String(args[0]);
      const classNameWithSlashes = classNameWithDots.replace(/\./g, '/');
      return await jvm.getClassObject(classNameWithSlashes);
    },
  },
  methods: {
    'getFields()[Ljava/lang/reflect/Field;': (jvm, classObj, args) => {
      return [];
    },
    'getName()Ljava/lang/String;': (jvm, classObj, args) => {
      // Handle primitive class objects
      if (classObj.isPrimitive && classObj.name) {
        return jvm.internString(classObj.name);
      }

      const classData = classObj._classData;
      if (!classData || !classData.ast) {
        if (classObj.type) {
          return jvm.internString(classObj.type.replace(/\//g, '.'));
        }
        return jvm.internString("java.lang.Class");
      }

      const className = classData.ast.classes[0].className.replace(/\//g, '.');
      return jvm.internString(className);
    },
    'getSimpleName()Ljava/lang/String;': (jvm, classObj, args) => {
      if (classObj.className) {
        return jvm.internString(classObj.className.split('.').pop());
      }
      
      const classData = classObj._classData;
      if (classData && classData.ast && classData.ast.classes[0]) {
        const fullName = classData.ast.classes[0].className;
        const simpleName = fullName.split('/').pop().split('$').pop();
        return jvm.internString(simpleName);
      }
      
      return jvm.internString('Unknown');
    },
    'getSuperclass()Ljava/lang/Class;': async (jvm, classObj, args) => {
      const classData = classObj._classData;
      const superClassName = classData.ast.classes[0].superClassName;
      if (!superClassName) {
        return null;
      }
      const superClassData = await jvm.loadClassByName(superClassName);
      if (!superClassData) {
        return null;
      }
      return {
        type: 'java/lang/Class',
        _classData: superClassData,
      };
    },
    'isInterface()Z': (jvm, classObj, args) => {
      const classData = classObj._classData;
      return classData.ast.classes[0].flags.includes('interface');
    },
    'isPrimitive()Z': (jvm, classObj, args) => {
      // Check if this is a primitive type class
      return classObj.isPrimitive ? 1 : 0;
    },
    'isInstance(Ljava/lang/Object;)Z': async (jvm, classObj, args) => {
      const obj = args[0];
      if (obj === null || obj === undefined || classObj.isPrimitive) return 0;
      const target = classNameFor(classObj);
      return await jvm.isInstanceOfAsync(runtimeClassName(obj), target) ? 1 : 0;
    },
    'isAssignableFrom(Ljava/lang/Class;)Z': async (jvm, classObj, args) => {
      if (!args[0] || classObj.isPrimitive || args[0].isPrimitive) {
        return classObj === args[0] ? 1 : 0;
      }
      const target = classNameFor(classObj);
      const source = classNameFor(args[0]);
      return await jvm.isInstanceOfAsync(source, target) ? 1 : 0;
    },
    'isArray()Z': (jvm, classObj, args) => {
      // Check if this is an array class
      const classData = classObj._classData;
      return classData && classData.isArray ? 1 : 0;
    },
    'isEnum()Z': (jvm, classObj, args) => {
      const classData = classObj._classData;
      if (!classData || !classData.ast || !classData.ast.classes[0]) return 0;
      let current = classData.ast.classes[0].superClassName;
      while (current) {
        if (current === 'java/lang/Enum') return 1;
        const currentData = jvm.classes[current];
        current = currentData && currentData.ast && currentData.ast.classes[0]
          ? currentData.ast.classes[0].superClassName
          : null;
      }
      return 0;
    },
    'getEnumConstants()[Ljava/lang/Object;': (jvm, classObj, args) => {
      const classData = classObj._classData;
      if (!classData || !classData.ast || !classData.ast.classes[0]) return null;
      const className = classData.ast.classes[0].className;
      const values = [];
      if (classData.staticFields) {
        for (const [fieldKey, value] of classData.staticFields.entries()) {
          if (!value || (value.type !== className && value._className !== className)) continue;
          if (String(fieldKey).includes('$VALUES')) continue;
          values.push(value);
        }
      }
      if (values.length === 0) return null;
      values.type = `[L${className};`;
      values.elementType = className;
      values.hashCode = jvm.nextHashCode++;
      return values;
    },
    'getMethods()[Ljava/lang/reflect/Method;': (jvm, classObj, args) => {
      const allMethods = {};

      const getMethodsRecursive = (currentClassObj) => {
        const classData = currentClassObj._classData;
        if (!classData || !classData.ast) {
          return;
        }

        const currentClassName = classData.ast.classes[0].className;
        classData.ast.classes[0].items
          .filter(item =>
            item.type === 'method' &&
            item.method.flags.includes('public') &&
            item.method.name !== '<init>' &&
            !(currentClassName === 'java/lang/Object' && item.method.name === 'clone'))
          .forEach(methodItem => {
            const key = methodItem.method.name + methodItem.method.descriptor;
            if (!allMethods[key]) {
              allMethods[key] = {
                type: 'java/lang/reflect/Method',
                _methodData: methodItem.method,
                _declaringClass: currentClassObj,
              };
            }
          });

        const superClassName = classData.ast.classes[0].superClassName;
        if (superClassName) {
          const superClassData = jvm.classes[superClassName];
          if (superClassData) {
            getMethodsRecursive({ type: 'java/lang/Class', _classData: superClassData });
          }
        }
      };

      getMethodsRecursive(classObj);

      // Special case for String, which is a native-implemented class
      if (classObj._classData.ast.classes[0].className === 'java/lang/String') {
        const stringMethods = require('./String.js');
        Object.keys(stringMethods.methods).forEach(methodSignature => {
          const openParen = methodSignature.indexOf('(');
          const name = methodSignature.substring(0, openParen);
          if (name === '<init>') {
            return;
          }
          const descriptor = methodSignature.substring(openParen);
          const key = name + descriptor;
          if (!allMethods[key]) {
            allMethods[key] = {
              type: 'java/lang/reflect/Method',
              _methodData: { name, descriptor, flags: ['public'] },
              _declaringClass: classObj,
            };
          }
        });
      }

      const objectMethods = require('./Object.js');
      
      const objectMethodAccessModifiers = {
        'getClass': ['public', 'final', 'native'],
        'hashCode': ['public', 'native'],
        'equals': ['public'],
        'toString': ['public'],
        'clone': ['protected', 'native'],
        'wait': ['public', 'final', 'native'],
        'notify': ['public', 'final', 'native'],
        'notifyAll': ['public', 'final', 'native'],
      };
      
      Object.keys(objectMethods.methods).forEach(methodSignature => {
          const openParen = methodSignature.indexOf('(');
          const name = methodSignature.substring(0, openParen);
          const descriptor = methodSignature.substring(openParen);
          const key = name + descriptor;
          
          const flags = objectMethodAccessModifiers[name] || ['public'];
          if (flags.includes('public') && !allMethods[key] && name !== '<init>') {
              allMethods[key] = {
                  type: 'java/lang/reflect/Method',
                  _methodData: { name, descriptor, flags, attributes: [] },
                  _declaringClass: { type: 'java/lang/Class', _classData: jvm.classes['java/lang/Object'] },
              };
          }
      });

      return Object.values(allMethods);
    },
    'getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;': withThrows(async (jvm, classObj, args) => {
      const methodName = String(args[0]);
      const paramTypes = args[1];

      const getDescriptor = (paramClass) => {
        if (!paramClass) return '';
        if (paramClass.isPrimitive) {
          switch (paramClass.name) {
            case 'int': return 'I';
            case 'long': return 'J';
            case 'double': return 'D';
            case 'float': return 'F';
            case 'char': return 'C';
            case 'short': return 'S';
            case 'byte': return 'B';
            case 'boolean': return 'Z';
            default:
              throw {
                type: 'java/lang/IllegalArgumentException',
                message: `Unknown primitive type: ${paramClass.name}`,
              };
          }
        }
        const paramClassName = paramClass._classData.ast.classes[0].className;
        return `L${paramClassName};`;
      };
      const targetDescriptor = `(${paramTypes.map(getDescriptor).join('')})`;

      let currentClass = classObj._classData;
      while (currentClass) {
        const methods = currentClass.ast.classes[0].items.filter(item => item.type === 'method');
        const method = methods.find(m => {
            const d = m.method.descriptor;
            const sub = d.substring(0, d.indexOf(')') + 1);
            return m.method.name === methodName && sub === targetDescriptor && m.method.flags.includes('public');
        });

        if (method) {
            return {
            type: 'java/lang/reflect/Method',
            _methodData: method.method,
            _declaringClass: { type: 'java/lang/Class', _classData: currentClass },
            _annotations: method.method.annotations || [],
            };
        }

        const superClassName = currentClass.ast.classes[0].superClassName;
        if (superClassName) {
            currentClass = await jvm.loadClassByName(superClassName);
        } else {
            currentClass = null;
        }
      }

      throw {
        type: 'java/lang/NoSuchMethodException',
        message: methodName,
      };
    }, ['java/lang/NoSuchMethodException', 'java/lang/IllegalArgumentException']),
    'getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;': withThrows((jvm, classObj, args) => {
      const methodNameObj = args[0];
      const paramTypes = args[1];

      let methodName;
      if (typeof methodNameObj === 'string') {
        methodName = methodNameObj;
      } else if (methodNameObj && methodNameObj.value) {
        methodName = methodNameObj.value;
      } else if (methodNameObj && typeof methodNameObj.toString === 'function') {
        methodName = methodNameObj.toString();
      } else {
        methodName = String(methodNameObj);
      }

      const classData = classObj._classData;
      const methods = classData.ast.classes[0].items.filter(item => item.type === 'method');

      const getDescriptor = (paramClass) => {
        if (!paramClass) return '';
        if (paramClass.isPrimitive) {
          switch (paramClass.name) {
            case 'int': return 'I';
            case 'long': return 'J';
            case 'double': return 'D';
            case 'float': return 'F';
            case 'char': return 'C';
            case 'short': return 'S';
            case 'byte': return 'B';
            case 'boolean': return 'Z';
            default:
              throw {
                type: 'java/lang/IllegalArgumentException',
                message: `Unknown primitive type: ${paramClass.name}`,
              };
          }
        }
        const paramClassName = paramClass._classData.ast.classes[0].className;
        return `L${paramClassName};`;
      };

      const targetDescriptor = `(${paramTypes.map(getDescriptor).join('')})`;
      
      const method = methods.find(m => {
        const d = m.method.descriptor;
        const methodDescriptor = d.substring(0, d.indexOf(')') + 1);
        return m.method.name === methodName && methodDescriptor === targetDescriptor;
      });

      if (method) {
        return {
          type: 'java/lang/reflect/Method',
          _methodData: method.method,
          _declaringClass: classObj,
          _annotations: method.method.annotations || [],
        };
      } else {
        throw {
          type: 'java/lang/NoSuchMethodException',
          message: methodName,
        };
      }
    }, ['java/lang/NoSuchMethodException', 'java/lang/IllegalArgumentException']),
    'getDeclaredField(Ljava/lang/String;)Ljava/lang/reflect/Field;': withThrows((jvm, classObj, args) => {
      const fieldNameObj = args[0];
      
      let fieldName;
      if (typeof fieldNameObj === 'string') {
        fieldName = fieldNameObj;
      } else if (fieldNameObj && fieldNameObj.value) {
        fieldName = fieldNameObj.value;
      } else if (fieldNameObj && typeof fieldNameObj.toString === 'function') {
        fieldName = fieldNameObj.toString();
      } else {
        fieldName = String(fieldNameObj);
      }
      
      const classData = classObj._classData;
      
      const field = classData.ast.classes[0].items.find(item => 
        item.type === 'field' && item.field.name === fieldName
      );
      
      if (field) {
        return {
          type: 'java/lang/reflect/Field',
          _fieldData: field.field,
          _declaringClass: classObj,
          _annotations: field.field.annotations || [],
        };
      } else {
        throw {
          type: 'java/lang/NoSuchFieldException',
          message: fieldName,
        };
      }
    }, ['java/lang/NoSuchFieldException']),
    'getDeclaredFields()[Ljava/lang/reflect/Field;': (jvm, classObj, args) => {
      const classData = classObj._classData;
      const fields = classData.ast.classes[0].items.filter(item => item.type === 'field');
      
      return fields.map(fieldItem => ({
        type: 'java/lang/reflect/Field',
        _fieldData: fieldItem.field,
        _declaringClass: classObj,
        _annotations: fieldItem.field.annotations || [],
      }));
    },
    'isAnnotationPresent(Ljava/lang/Class;)Z': (jvm, classObj, args) => {
      const annotationClass = args[0];
      const classData = classObj._classData;
      const annotations = (classData.ast && classData.ast.annotations) ? classData.ast.annotations : [];
      
      return annotations.some(ann => {
        const annotationType = ann.type;
        const annotationClassName = annotationClass._classData ? 
          annotationClass._classData.ast.classes[0].className : 
          annotationClass.className;
        return annotationType === annotationClassName;
      });
    },
    'getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;': (jvm, classObj, args) => {
      const annotationClass = args[0];
      const classData = classObj._classData;
      const annotations = (classData.ast && classData.ast.annotations) ? classData.ast.annotations : [];
      
      const annotation = annotations.find(ann => {
        const annotationType = ann.type;
        const annotationClassName = annotationClass._classData ? 
          annotationClass._classData.ast.classes[0].className : 
          annotationClass.className;
        return annotationType === annotationClassName;
      });
      
      if (annotation) {
        return jvm.createAnnotationProxy(annotation);
      }
      
      return null;
    },
    'newInstance()Ljava/lang/Object;': (jvm, classObj, args) => {
      const classData = classObj._classData;
      const className = classData.ast.classes[0].className;
      const newObj = jvm.newObject(className);
      const constructor = jvm.findMethod(className, '<init>()V');
      if (constructor) {
        jvm.runMethod(constructor, [newObj]);
      }
      return newObj;
    },
    'getResource(Ljava/lang/String;)Ljava/net/URL;': (jvm, classObj, args) => {
      const name = String(args[0]);
      const classData = classObj._classData;
      const className = classData && classData.ast && classData.ast.classes[0]
        ? classData.ast.classes[0].className
        : 'java/lang/Object';
      const base = className.includes('/') ? className.substring(0, className.lastIndexOf('/') + 1) : '';
      const resource = name.startsWith('/') ? name.substring(1) : base + name;
      return {
        type: 'java/net/URL',
        url: jvm.internString(`file:/${resource}`),
        hashCode: jvm.nextHashCode++,
      };
    },
    'getClassLoader()Ljava/lang/ClassLoader;': (jvm, classObj, args) => {
      // Return null to indicate the bootstrap class loader
      return null;
    }
  }
};

const classJre = module.exports;

classJre.methods['getMethod(Ljava/lang/String;)Ljava/lang/reflect/Method;'] = (jvm, classObj, args, thread) => (
  classJre.methods['getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'](jvm, classObj, [args[0], []], thread)
);

classJre.methods['getDeclaredMethod(Ljava/lang/String;)Ljava/lang/reflect/Method;'] = (jvm, classObj, args, thread) => (
  classJre.methods['getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'](jvm, classObj, [args[0], []], thread)
);

classJre.methods['getDeclaredMethod(Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/reflect/Method;'] = (jvm, classObj, args, thread) => (
  classJre.methods['getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'](jvm, classObj, [args[0], [args[1]]], thread)
);
