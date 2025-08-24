module.exports = {
  super: "java/lang/Object",
  interfaces: [],
  staticFields: {},
  staticMethods: {
    'getTimeZone(Ljava/lang/String;)Ljava/util/TimeZone;': (jvm, obj, args) => {
      const zoneId = args[0];
      // For now, return a dummy TimeZone object.
      return {
        type: 'java/util/TimeZone',
        _zoneId: zoneId,
        fields: {},
        hashCode: jvm.nextHashCode++,
      };
    },
  },
  methods: {},
};
