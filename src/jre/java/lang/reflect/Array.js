module.exports = {
  name: 'java/lang/reflect/Array',
  super: 'java/lang/Object',
  staticMethods: {
    'newInstance(Ljava/lang/Class;I)Ljava/lang/Object;': (jvm, _, args) => {
      const componentType = args[0];
      const length = args[1];
      const array = new Array(length).fill(null);
      array.type = `[${componentType.className.replace(/\./g, '/')}`;
      array.elementType = componentType.className;
      return array;
    },
    'newInstance(Ljava/lang/Class;[I)Ljava/lang/Object;': (jvm, _, args) => {
      const componentType = args[0];
      const dimensions = args[1];
      const rawDimensions = dimensions && dimensions.elements
        ? dimensions.elements
        : Array.from(dimensions || []);
      const componentName = componentType && componentType.isPrimitive
        ? componentType.name
        : (componentType && (componentType.className || componentType.type)) || 'java/lang/Object';
      const primitiveDescriptors = {
        boolean: 'Z',
        byte: 'B',
        char: 'C',
        short: 'S',
        int: 'I',
        long: 'J',
        float: 'F',
        double: 'D',
      };
      const leafDescriptor = primitiveDescriptors[componentName] || (componentName.startsWith('[') ? componentName : `L${componentName.replace(/\./g, '/')};`);
      const arrayType = `${'['.repeat(rawDimensions.length)}${leafDescriptor}`;
      const createArray = (depth) => {
        const length = rawDimensions[depth] || 0;
        const array = new Array(length);
        array.type = `${'['.repeat(rawDimensions.length - depth)}${leafDescriptor}`;
        array.elementType = depth + 1 < rawDimensions.length
          ? `${'['.repeat(rawDimensions.length - depth - 1)}${leafDescriptor}`
          : leafDescriptor;
        if (depth + 1 < rawDimensions.length) {
          for (let i = 0; i < length; i += 1) array[i] = createArray(depth + 1);
        } else {
          array.fill(['I', 'J', 'F', 'D', 'B', 'S', 'C'].includes(leafDescriptor) ? 0 : null);
        }
        return array;
      };
      const array = createArray(0);
      array.type = arrayType;
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
