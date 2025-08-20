const { MethodType } = require('./index');

const { classToDescriptor } = require('/app/src/jre/utils');

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'methodType(Ljava/lang/Class;[Ljava/lang/Class;)Ljava/lang/invoke/MethodType;': (jvm, obj, args) => {
      const rtype = args[0];
      const ptypes = args[1] ? args[1].array : [];
      const rtypeDesc = classToDescriptor(rtype);
      const ptypeDescs = ptypes.map(ptype => classToDescriptor(ptype));
      return new MethodType(ptypeDescs, rtypeDesc);
    },
    'methodType(Ljava/lang/Class;Ljava/lang/Class;)Ljava/lang/invoke/MethodType;': (jvm, obj, args) => {
      const rtype = args[0];
      const ptype0 = args[1];
      const rtypeDesc = classToDescriptor(rtype);
      const ptypeDesc0 = classToDescriptor(ptype0);
      return new MethodType([ptypeDesc0], rtypeDesc);
    },
    'methodType(Ljava/lang/Class;)Ljava/lang/invoke/MethodType;': (jvm, obj, args) => {
      const rtype = args[0];
      const rtypeDesc = classToDescriptor(rtype);
      return new MethodType([], rtypeDesc);
    }
  }
};