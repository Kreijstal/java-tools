module.exports = {
  super: 'java/lang/Object',
  fields: {
    'left:I': 0,
    'top:I': 0,
  },
  methods: {
    '<init>(IIII)V': (jvm, obj, args) => {
      obj.top = args[0];
      obj.left = args[1];
      // bottom and right are ignored for now
    },
  },
};
