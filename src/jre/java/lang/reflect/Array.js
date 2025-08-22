const { primitiveTypeNameToDescriptor } = require("../../../constants");

module.exports = {
  name: 'java/lang/reflect/Array',
  super: 'java/lang/Object',
  staticMethods: {
    'newInstance(Ljava/lang/Class;I)Ljava/lang/Object;': (jvm, _, args) => {
      const componentType = args[0];
      const length = args[1];

      let typeDescriptor;
      const componentName = componentType.name || componentType.className;

      if (componentType.isPrimitive) {
        typeDescriptor = primitiveTypeNameToDescriptor[componentName];
      } else {
        typeDescriptor = `L${componentName.replace(/\./g, '/')};`;
      }

      const array = new Array(length);

      if (componentType.isPrimitive) {
          const defaultValue = (typeDescriptor === 'J') ? BigInt(0) : 0;
          array.fill(defaultValue);
      } else {
          array.fill(null);
      }

      array.type = `[${typeDescriptor}`;
      array.elementType = componentName;
      return array;
    },
    'getLength(Ljava/lang/Object;)I': (jvm, _, args) => {
      const array = args[0];
      return array.length;
    },
    'get(Ljava/lang/Object;I)Ljava/lang/Object;': (jvm, _, args) => {
      const array = args[0];
      const index = args[1];
      return array[index];
    },
    'set(Ljava/lang/Object;ILjava/lang/Object;)V': (jvm, _, args) => {
      const array = args[0];
      const index = args[1];
      const value = args[2];
      array[index] = value;
    },
    'getInt(Ljava/lang/Object;I)I': (jvm, _, args) => {
      const array = args[0];
      const index = args[1];
      return array[index];
    },
    'setInt(Ljava/lang/Object;II)V': (jvm, _, args) => {
      const array = args[0];
      const index = args[1];
      const value = args[2];
      array[index] = value;
    },
    'getDouble(Ljava/lang/Object;I)D': (jvm, _, args) => {
      const array = args[0];
      const index = args[1];
      return array[index];
    },
    'setDouble(Ljava/lang/Object;ID)V': (jvm, _, args) => {
      const array = args[0];
      const index = args[1];
      const value = args[2];
      array[index] = value;
    },
  },
};
