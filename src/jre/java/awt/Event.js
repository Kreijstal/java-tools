module.exports = {
  super: 'java/lang/Object',
  fields: {
    'id:I': 0,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.id = 0;
      obj.fields = obj.fields || {};
      obj.fields['java/awt/Event.id'] = 0;
    },
  },
};
