module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'equals(Ljava/lang/Object;Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const a = args[0];
      const b = args[1];
      
      if (a === null && b === null) {
        return 1;
      }
      if (a === null || b === null) {
        return 0;
      }
      
      // Call equals method on object a
      const equalsMethod = jvm._jreFindMethod(a.type, 'equals', '(Ljava/lang/Object;)Z');
      if (equalsMethod) {
        return equalsMethod(jvm, a, [b]);
      }
      
      // Fallback to reference equality
      return a === b ? 1 : 0;
    },
    'hash([Ljava/lang/Object;)I': (jvm, obj, args) => {
      const values = args[0];
      if (!values) {
        return 0;
      }
      
      let result = 1;
      for (const element of values) {
        let elementHash = 0;
        if (element !== null) {
          const hashCodeMethod = jvm._jreFindMethod(element.type, 'hashCode', '()I');
          if (hashCodeMethod) {
            elementHash = hashCodeMethod(jvm, element, []);
          } else {
            elementHash = element.hashCode || 0;
          }
        }
        result = 31 * result + elementHash;
      }
      return result;
    },
    'hashCode(Ljava/lang/Object;)I': (jvm, obj, args) => {
      const o = args[0];
      if (o === null) {
        return 0;
      }
      
      const hashCodeMethod = jvm._jreFindMethod(o.type, 'hashCode', '()I');
      if (hashCodeMethod) {
        return hashCodeMethod(jvm, o, []);
      }
      
      return o.hashCode || 0;
    },
    'toString(Ljava/lang/Object;)Ljava/lang/String;': (jvm, obj, args) => {
      const o = args[0];
      if (o === null) {
        return jvm.internString('null');
      }
      
      const toStringMethod = jvm._jreFindMethod(o.type, 'toString', '()Ljava/lang/String;');
      if (toStringMethod) {
        return toStringMethod(jvm, o, []);
      }
      
      return jvm.internString(o.toString());
    },
    'requireNonNull(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const o = args[0];
      if (o === null) {
        throw {
          type: 'java/lang/NullPointerException',
          message: 'null'
        };
      }
      return o;
    },
    'requireNonNull(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/Object;': (jvm, obj, args) => {
      const o = args[0];
      const message = args[1];
      if (o === null) {
        throw {
          type: 'java/lang/NullPointerException',
          message: message || 'null'
        };
      }
      return o;
    },
  },
};