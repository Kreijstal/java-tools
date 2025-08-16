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
  },
};
