module.exports = {
  super: "java/lang/Object",
  staticFields: {},
  staticMethods: {
    "methodType(Ljava/lang/Class;Ljava/lang/Class;)Ljava/lang/invoke/MethodType;":
      (jvm, obj, args) => {
        const returnType = args[0];
        const paramType = args[1];

        // Create MethodType object
        const methodType = {
          type: "java/lang/invoke/MethodType",
          returnType: returnType,
          parameterTypes: [paramType],
        };

        return methodType;
      },
    "methodType(Ljava/lang/Class;[Ljava/lang/Class;)Ljava/lang/invoke/MethodType;":
      (jvm, obj, args) => {
        const returnType = args[0];
        const paramTypes = args[1];

        // Create MethodType object
        const methodType = {
          type: "java/lang/invoke/MethodType",
          returnType: returnType,
          parameterTypes: paramTypes || [],
        };

        return methodType;
      },
    "methodType(Ljava/lang/Class;Ljava/lang/Class;Ljava/lang/Class;)Ljava/lang/invoke/MethodType;":
      (jvm, obj, args) => {
        const returnType = args[0];
        const paramType1 = args[1];
        const paramType2 = args[2];

        // Create MethodType object
        const methodType = {
          type: "java/lang/invoke/MethodType",
          returnType: returnType,
          parameterTypes: [paramType1, paramType2],
        };

        return methodType;
      },
    "methodType(Ljava/lang/Class;Ljava/lang/Class;[Ljava/lang/Class;)Ljava/lang/invoke/MethodType;":
      (jvm, obj, args) => {
        const returnType = args[0];
        const firstParamType = args[1];
        const additionalParamTypes = args[2] || [];

        // Create MethodType object
        const methodType = {
          type: "java/lang/invoke/MethodType",
          returnType: returnType,
          parameterTypes: [firstParamType, ...additionalParamTypes],
        };

        return methodType;
      },
  },
  methods: {},
};
