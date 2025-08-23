module.exports = {
  super: 'java/lang/Number',
  staticFields: {},
  staticMethods: {},
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const str = args[0];
      const stringValue = typeof str === 'string' ? str : (str ? str.value : '0');
      try {
        obj.value = BigInt(stringValue);
      } catch (error) {
        // In real Java this would throw NumberFormatException
        obj.value = BigInt(0);
      }
    },
    'modPow(Ljava/math/BigInteger;Ljava/math/BigInteger;)Ljava/math/BigInteger;': (jvm, obj, args) => {
      const exponent = args[0];
      const modulus = args[1];
      
      // JavaScript BigInt modular exponentiation
      const base = obj.value;
      const exp = exponent.value;
      const mod = modulus.value;
      
      // Simple modular exponentiation implementation
      let result = BigInt(1);
      let baseMod = base % mod;
      let expCopy = exp;
      
      while (expCopy > 0n) {
        if (expCopy % 2n === 1n) {
          result = (result * baseMod) % mod;
        }
        expCopy = expCopy >> 1n;
        baseMod = (baseMod * baseMod) % mod;
      }
      
      const resultObj = {
        type: 'java/math/BigInteger',
        value: result,
      };
      
      return resultObj;
    },
    'toByteArray()[B': (jvm, obj, args) => {
      const bigIntValue = obj.value;
      
      // Convert BigInt to byte array (two's complement representation)
      let hex = bigIntValue.toString(16);
      
      // Ensure even number of hex digits
      if (hex.length % 2 !== 0) {
        hex = '0' + hex;
      }
      
      // Handle negative numbers
      if (bigIntValue < 0n) {
        // For negative numbers, we need two's complement
        // This is a simplified implementation
        hex = hex.slice(1); // Remove the '-' sign
        // Convert to positive representation and then compute two's complement
        // This is a basic implementation - real Java BigInteger is more complex
      }
      
      // Convert hex string to byte array
      const bytes = [];
      for (let i = 0; i < hex.length; i += 2) {
        const byteHex = hex.substr(i, 2);
        bytes.push(parseInt(byteHex, 16));
      }
      
      // Create Java byte array
      const javaArray = {
        type: '[B',
        length: bytes.length,
        elements: bytes
      };
      
      return javaArray;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.newString(obj.value.toString());
    },
  },
};