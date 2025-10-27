module.exports = {
  super: 'java/lang/reflect/AccessibleObject',
  staticFields: {},
  methods: {
    'getName()Ljava/lang/String;': (jvm, fieldObj, args) => {
      const fieldName = fieldObj._fieldData.name;
      return jvm.internString(fieldName);
    },
    'getType()Ljava/lang/Class;': async (jvm, fieldObj, args) => {
      const descriptor = fieldObj._fieldData.descriptor;
      
      // Parse the field descriptor to get the type
      if (descriptor === 'I') {
        // Return int.class - need to create primitive class objects
        return {
          type: 'java/lang/Class',
          isPrimitive: true,
          name: 'int'
        };
      } else if (descriptor === 'Z') {
        return {
          type: 'java/lang/Class',
          isPrimitive: true,
          name: 'boolean'
        };
      } else if (descriptor === 'J') {
        return {
          type: 'java/lang/Class',
          isPrimitive: true,
          name: 'long'
        };
      } else if (descriptor === 'D') {
        return {
          type: 'java/lang/Class',
          isPrimitive: true,
          name: 'double'
        };
      } else if (descriptor === 'F') {
        return {
          type: 'java/lang/Class',
          isPrimitive: true,
          name: 'float'
        };
      } else if (descriptor === 'C') {
        return {
          type: 'java/lang/Class',
          isPrimitive: true,
          name: 'char'
        };
      } else if (descriptor === 'S') {
        return {
          type: 'java/lang/Class',
          isPrimitive: true,
          name: 'short'
        };
      } else if (descriptor === 'B') {
        return {
          type: 'java/lang/Class',
          isPrimitive: true,
          name: 'byte'
        };
      } else if (descriptor.startsWith('L') && descriptor.endsWith(';')) {
        // Object type
        const className = descriptor.slice(1, -1);
        const classData = await jvm.loadClassByName(className);
        if (!classData) {
          throw {
            type: 'java/lang/ClassNotFoundException',
            message: className,
          };
        }
        return {
          type: 'java/lang/Class',
          _classData: classData,
        };
      } else if (descriptor.startsWith('[')) {
        // Array type - for now return Object.class
        return {
          type: 'java/lang/Class',
          _classData: jvm.classes['java/lang/Object'],
        };
      }
      
      throw new Error(`Unsupported field descriptor: ${descriptor}`);
    },
    'getModifiers()I': (jvm, fieldObj, args) => {
      const accessFlags = fieldObj._fieldData.accessFlags;
      return accessFlags;
    },
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, fieldObj, args) => {
      const obj = args[0];
      const fieldData = fieldObj._fieldData;
      const fieldName = fieldData.name;
      
      if (fieldData.accessFlags & 0x0008) { // ACC_STATIC
        // Static field - get from class static fields
        const declaringClass = fieldObj._declaringClass;
        const classData = declaringClass._classData;
        const fieldKey = `${fieldName}:${fieldData.descriptor}`;

        if (classData.staticFields instanceof Map) {
          if (classData.staticFields.has(fieldKey)) {
            return classData.staticFields.get(fieldKey);
          }
        } else if (
          classData.staticFields &&
          Object.prototype.hasOwnProperty.call(classData.staticFields, fieldKey)
        ) {
          return classData.staticFields[fieldKey];
        }
        return null;
      } else {
        // Instance field
        if (obj === null) {
          throw {
            type: 'java/lang/NullPointerException',
            message: `Cannot get field ${fieldName} from null object`,
          };
        }
        return obj[fieldName];
      }
    },
    'set(Ljava/lang/Object;Ljava/lang/Object;)V': (jvm, fieldObj, args) => {
      const obj = args[0];
      const value = args[1];
      const fieldData = fieldObj._fieldData;
      const fieldName = fieldData.name;
      
      if (fieldData.accessFlags & 0x0008) { // ACC_STATIC
        // Static field - set in class static fields
        const declaringClass = fieldObj._declaringClass;
        const classData = declaringClass._classData;
        if (!(classData.staticFields instanceof Map)) {
          classData.staticFields = new Map();
        }
        const fieldKey = `${fieldName}:${fieldData.descriptor}`;
        classData.staticFields.set(fieldKey, value);
      } else {
        // Instance field
        if (obj === null) {
          throw {
            type: 'java/lang/NullPointerException',
            message: `Cannot set field ${fieldName} on null object`,
          };
        }
        obj[fieldName] = value;
      }
    },
    'isAnnotationPresent(Ljava/lang/Class;)Z': (jvm, fieldObj, args) => {
      const annotationClass = args[0];
      const annotations = fieldObj._annotations || [];
      
      // Check if annotation of the specified type is present
      return annotations.some(ann => {
        const annotationType = ann.type;
        const annotationClassName = annotationClass._classData ? 
          annotationClass._classData.ast.classes[0].className : 
          annotationClass.className;
        return annotationType === annotationClassName;
      });
    },
    'getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;': (jvm, fieldObj, args) => {
      const annotationClass = args[0];
      const annotations = fieldObj._annotations || [];
      
      // Find annotation of the specified type
      const annotation = annotations.find(ann => {
        const annotationType = ann.type;
        const annotationClassName = annotationClass._classData ? 
          annotationClass._classData.ast.classes[0].className : 
          annotationClass.className;
        return annotationType === annotationClassName;
      });
      
      if (annotation) {
        // Create annotation proxy object
        return jvm.createAnnotationProxy(annotation);
      }
      
      return null;
    },
    'getInt(Ljava/lang/Object;)I': (jvm, fieldObj, args) => {
      const obj = args[0];
      const fieldData = fieldObj._fieldData;
      const fieldName = fieldData.name;

      if (fieldData.accessFlags & 0x0008) { // ACC_STATIC
        const declaringClass = fieldObj._declaringClass;
        const classData = declaringClass._classData;
        const fieldKey = `${fieldName}:${fieldData.descriptor}`;

        if (classData.staticFields instanceof Map) {
          if (classData.staticFields.has(fieldKey)) {
            return classData.staticFields.get(fieldKey);
          }
        } else if (
          classData.staticFields &&
          Object.prototype.hasOwnProperty.call(classData.staticFields, fieldKey)
        ) {
          return classData.staticFields[fieldKey];
        }
        return 0;
      } else {
        if (obj === null) {
          throw {
            type: 'java/lang/NullPointerException',
            message: `Cannot get field ${fieldName} from null object`,
          };
        }
        return obj[fieldName];
      }
    },
    'setInt(Ljava/lang/Object;I)V': (jvm, fieldObj, args) => {
      const obj = args[0];
      const value = args[1];
      const fieldData = fieldObj._fieldData;
      const fieldName = fieldData.name;

      if (fieldData.accessFlags & 0x0008) { // ACC_STATIC
        const declaringClass = fieldObj._declaringClass;
        const classData = declaringClass._classData;
        if (!(classData.staticFields instanceof Map)) {
          classData.staticFields = new Map();
        }
        const fieldKey = `${fieldName}:${fieldData.descriptor}`;
        classData.staticFields.set(fieldKey, value);
      } else {
        if (obj === null) {
          throw {
            type: 'java/lang/NullPointerException',
            message: `Cannot set field ${fieldName} on null object`,
          };
        }
        obj[fieldName] = value;
      }
    }
  }
};