module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'ZERO': null, // Will be initialized by JVM
  },
  staticMethods: {
    'ofSeconds(J)Ljava/time/Duration;': (jvm, args) => {
      const seconds = args && args.length > 0 ? args[0] : 0;
      return {
        type: 'java/time/Duration',
        seconds: seconds,
        nanos: 0,
      };
    },
    'ofMillis(J)Ljava/time/Duration;': (jvm, args) => {
      const millis = args && args.length > 0 ? args[0] : 0;
      return {
        type: 'java/time/Duration',
        seconds: Math.floor(millis / 1000),
        nanos: (millis % 1000) * 1000000,
      };
    },
    'ofNanos(J)Ljava/time/Duration;': (jvm, args) => {
      const nanos = args && args.length > 0 ? args[0] : 0;
      return {
        type: 'java/time/Duration',
        seconds: Math.floor(nanos / 1000000000),
        nanos: nanos % 1000000000,
      };
    },
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.seconds = 0;
      obj.nanos = 0;
    },
    'getSeconds()J': (jvm, obj, args) => {
      return obj.seconds || 0;
    },
    'getNano()I': (jvm, obj, args) => {
      return obj.nanos || 0;
    },
    'toMillis()J': (jvm, obj, args) => {
      const seconds = obj.seconds || 0;
      const nanos = obj.nanos || 0;
      return seconds * 1000 + Math.floor(nanos / 1000000);
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const seconds = obj.seconds || 0;
      const nanos = obj.nanos || 0;
      if (seconds === 0 && nanos === 0) {
        return jvm.internString('PT0S');
      }
      let result = 'PT';
      if (seconds !== 0) {
        result += seconds + 'S';
      }
      if (nanos !== 0) {
        result += (nanos / 1000000000) + 'S';
      }
      return jvm.internString(result);
    },
  },
};