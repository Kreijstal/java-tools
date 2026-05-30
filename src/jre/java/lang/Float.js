function javaFloatString(value) {
  const f = Number(value);
  if (isNaN(f)) {
    return "NaN";
  }
  if (f === Number.POSITIVE_INFINITY) {
    return "Infinity";
  }
  if (f === Number.NEGATIVE_INFINITY) {
    return "-Infinity";
  }
  if (Object.is(f, -0)) {
    return "-0.0";
  }
  if (f === 0.0) {
    return "0.0";
  }

  const absF = Math.abs(f);
  let s;

  if (absF >= 1e-3 && absF < 1e7) {
    s = String(f);
    if (s.indexOf('.') === -1) {
      s += '.0';
    }
  } else {
    s = f.toExponential().toUpperCase().replace(/E\+/, 'E');
    let [mantissa, exponent] = s.split('E');
    if (mantissa.includes('.')) {
      mantissa = mantissa.replace(/0+$/, '');
      if (mantissa.endsWith('.')) {
        mantissa = mantissa.slice(0, -1);
      }
    }
    s = mantissa + 'E' + exponent;
  }

  return s;
}

module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'float',
    },
    'MAX_VALUE:F': 3.4028234663852886e38,
    'MIN_NORMAL:F': 1.1754943508222875e-38,
    'MIN_VALUE:F': 1.401298464324817e-45,
    'POSITIVE_INFINITY:F': Number.POSITIVE_INFINITY,
    'NEGATIVE_INFINITY:F': Number.NEGATIVE_INFINITY,
    'NaN:F': Number.NaN,
  },
  staticMethods: {
    'intBitsToFloat(I)F': (jvm, obj, args) => {
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      view.setInt32(0, args[0], false);
      return view.getFloat32(0, false);
    },
    'floatToIntBits(F)I': (jvm, obj, args) => {
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      view.setFloat32(0, args[0], false);
      return view.getInt32(0, false);
    },
    'floatToRawIntBits(F)I': (jvm, obj, args) => {
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      view.setFloat32(0, args[0], false);
      return view.getInt32(0, false);
    },
    'valueOf(F)Ljava/lang/Float;': (jvm, obj, args) => {
      const floatObj = {
        type: 'java/lang/Float',
        value: args[0],
      };

      floatObj.toString = function() {
        return javaFloatString(this.value);
      };

      return floatObj;
    },
    'isInfinite(F)Z': (jvm, obj, args) => {
      const value = args[0];
      return !isFinite(value) && !isNaN(value) ? 1 : 0;
    },
    'isNaN(F)Z': (jvm, obj, args) => {
      return isNaN(args[0]) ? 1 : 0;
    },
    'isFinite(F)Z': (jvm, obj, args) => {
      return isFinite(args[0]) ? 1 : 0;
    },
    'toString(F)Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(javaFloatString(args[0]));
    },
  },
  methods: {
    '<init>(F)V': (jvm, obj, args) => {
      obj.value = args[0];

      obj.toString = function() {
        return javaFloatString(this.value);
      };
    },
    'floatValue()F': (jvm, obj, args) => {
      return obj.value;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(javaFloatString(obj.value));
    },
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      return {
        type: 'java/lang/Class',
        className: 'java/lang/Float',
        getSimpleName: function() {
          return jvm.internString('Float');
        }
      };
    },
  },
};
