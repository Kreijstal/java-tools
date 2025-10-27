const Decimal = require('decimal.js');

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, thisBigDecimal, [str]) => {
      const rawStr = typeof str === 'string' ? str : String(str);
      const normalizedStr =
        rawStr.startsWith('"') && rawStr.endsWith('"')
          ? rawStr.substring(1, rawStr.length - 1)
          : rawStr;
      thisBigDecimal.value = new Decimal(normalizedStr);
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

    'compareTo(Ljava/math/BigDecimal;)I': (jvm, thisBigDecimal, [otherBigDecimal]) => {
      return thisBigDecimal.value.comparedTo(otherBigDecimal.value);
    },

    'toString()Ljava/lang/String;': (jvm, thisBigDecimal) => {
        return jvm.internString(thisBigDecimal.value.toString());
    }
  }
};
