module.exports = {
  super: "java/lang/Object",
  interfaces: [],
  staticFields: {
    'YEAR:I': 1,
    'MONTH:I': 2,
    'DATE:I': 5,
  },
  staticMethods: {
    'getInstance()Ljava/util/Calendar;': (jvm) => {
      const zoneId = typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : 'UTC';
      return {
        type: 'java/util/Calendar',
        _timeZone: { type: 'java/util/TimeZone', _zoneId: zoneId || 'UTC', fields: {} },
        _date: new Date(),
        fields: {},
        hashCode: jvm.nextHashCode++,
      };
    },
    'getInstance(Ljava/util/TimeZone;)Ljava/util/Calendar;': (jvm, obj, args) => {
      const timeZone = args[0];
      // For now, return a dummy Calendar object.
      return {
        type: 'java/util/Calendar',
        _timeZone: timeZone,
        _date: null,
        fields: {},
        hashCode: jvm.nextHashCode++,
      };
    },
  },
  methods: {
    'getTimeZone()Ljava/util/TimeZone;': (jvm, obj) => obj._timeZone || {
      type: 'java/util/TimeZone',
      _zoneId: 'UTC',
      fields: {},
    },
    'setTime(Ljava/util/Date;)V': (jvm, obj, args) => {
      obj._date = args[0]._date; // get the underlying JS Date
    },
    'get(I)I': (jvm, obj, args) => {
      const field = args[0];
      if (obj._date) {
        switch (field) {
          case 1: // YEAR
            return obj._date.getFullYear();
          case 2: // MONTH
            return obj._date.getMonth();
          case 5: // DATE
            return obj._date.getDate();
        }
      }
      return 0;
    },
  },
};
