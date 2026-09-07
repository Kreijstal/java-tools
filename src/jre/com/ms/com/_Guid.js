const { writeField } = require('../../../../core/objectModel');
module.exports = {
  super: 'java/lang/Object',
  fields: {
    'data1:I': 0,
    'data2:S': 0,
    'data3:S': 0,
    'data4:[B': null,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.data1 = 0;
      obj.data2 = 0;
      obj.data3 = 0;
      obj.data4 = new Array(8).fill(0);
      obj.fields = obj.fields || {};
      writeField(obj.fields, 'com/ms/com/_Guid.data1', obj.data1);
      writeField(obj.fields, 'com/ms/com/_Guid.data2', obj.data2);
      writeField(obj.fields, 'com/ms/com/_Guid.data3', obj.data3);
      writeField(obj.fields, 'com/ms/com/_Guid.data4', obj.data4);
    },
  },
};
