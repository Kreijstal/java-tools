module.exports = {
  super: "java/lang/Object",
  interfaces: [],
  staticFields: {
    'YEAR:I': 1,
    'MONTH:I': 2,
    'DATE:I': 5,
  },
  staticMethods: {
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
