module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': (jvm, obj) => { obj._references = []; },
    'poll()Ljava/lang/ref/Reference;': (jvm, obj) => (
      obj._references && obj._references.length ? obj._references.shift() : null
    ),
  },
};
