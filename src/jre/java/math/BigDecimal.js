const Decimal = require('decimal.js');

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, thisBigDecimal, [str]) => {
      // The string from LDC comes with quotes, remove them.
      const unquotedStr = str.substring(1, str.length - 1);
      thisBigDecimal.value = new Decimal(unquotedStr);
      thisBigDecimal.type = 'java/math/BigDecimal';
      thisBigDecimal.toString = function() { return this.value.toString(); };
    },

    'add(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;': (jvm, thisBigDecimal, [otherBigDecimal]) => {
      const resultValue = thisBigDecimal.value.add(otherBigDecimal.value);
      const result = {
        type: 'java/math/BigDecimal',
        value: resultValue,
        toString: function() { return this.value.toString(); }
      };
      return result;
    },

    'toString()Ljava/lang/String;': (jvm, thisBigDecimal) => {
        return jvm.internString(thisBigDecimal.value.toString());
    }
  }
};
