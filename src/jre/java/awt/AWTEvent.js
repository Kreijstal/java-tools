module.exports = {
  super: 'java/util/EventObject',
  methods: {
    '<init>()V': () => {},
    'getID()I': (jvm, obj) => obj.id || 0,
    'getSource()Ljava/lang/Object;': (jvm, obj) => obj.source || null,
    'consume()V': (jvm, obj) => { obj._consumed = true; },
  },
};
