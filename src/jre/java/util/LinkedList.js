module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.list = [];
    },
    'size()I': (jvm, obj, args) => {
      return obj.list.length;
    },
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      obj.list.push(args[0]);
      return 1; // True
    },
    'removeFirst()Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.list.shift();
    },
    'get(I)Ljava/lang/Object;': (jvm, obj, args) => {
      const index = args[0];
      if (index < 0 || index >= obj.list.length) {
        throw {
          type: 'java/lang/IndexOutOfBoundsException',
          message: `Index: ${index}, Size: ${obj.list.length}`
        };
      }
      return obj.list[index];
    },
  },
};
