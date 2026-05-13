module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'float',
    },
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
        return this.value.toString();
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
      const f = args[0];
      if (isNaN(f)) {
        return jvm.internString("NaN");
      }
      if (f === Number.POSITIVE_INFINITY) {
        return jvm.internString("Infinity");
      }
      if (f === Number.NEGATIVE_INFINITY) {
        return jvm.internString("-Infinity");
      }
      if (f === 0.0) {
        return jvm.internString('0.0');
      }
      if (f === -0.0) {
        return jvm.internString('-0.0');
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

      return jvm.internString(s);
    },
  },
  methods: {
    '<init>(F)V': (jvm, obj, args) => {
      obj.value = args[0];

      obj.toString = function() {
        return this.value.toString();
      };
    },
    'floatValue()F': (jvm, obj, args) => {
      return obj.value;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.value.toString());
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
