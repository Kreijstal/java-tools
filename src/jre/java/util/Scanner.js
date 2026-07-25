const { withThrows } = require('../../helpers');

// JRE Class: java/util/Scanner

// Helper function to read the next token (word separated by whitespace)
function nextToken(jvm, obj) {
  const source = obj['java/util/Scanner/source'];
  if (!source) {
    return null;
  }
  
  let token = '';
  let charCode;
  let foundNonWhitespace = false;
  
  // Skip leading whitespace and read until next whitespace
  while (true) {
    if (source.read && typeof source.read === 'function') {
      // For TestInputStream objects created in test-helpers
      charCode = source.read();
    } else {
      // Try to find the read method via JRE method lookup
      const readMethod = jvm._jreFindMethod(source.type || 'java/io/InputStream', 'read', '()I');
      if (readMethod) {
        charCode = readMethod(jvm, source, []);
      } else {
        charCode = -1;
      }
    }
    
    if (charCode === -1) {
      // End of stream
      obj['java/util/Scanner/hasNext'] = false;
      break;
    }
    
    const char = String.fromCharCode(charCode);
    
    // Check if it's whitespace
    if (/\s/.test(char)) {
      if (foundNonWhitespace) {
        // We've found our token, stop here
        break;
      }
      // Still in leading whitespace, continue
    } else {
      foundNonWhitespace = true;
      token += char;
    }
  }
  
  return token || null;
}

module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>(Ljava/io/InputStream;)V': (jvm, obj, args) => {
      const inputStream = args[0];
      obj['java/util/Scanner/source'] = inputStream;
      obj['java/util/Scanner/closed'] = false;
      obj['java/util/Scanner/buffer'] = '';
      obj['java/util/Scanner/hasNext'] = true;
    },
    
    'nextLine()Ljava/lang/String;': withThrows((jvm, obj, args) => {
      if (obj['java/util/Scanner/closed']) {
        jvm.throwException('java/lang/IllegalStateException', 'Scanner closed');
        return;
      }
      
      const source = obj['java/util/Scanner/source'];
      if (!source) {
        jvm.throwException('java/util/NoSuchElementException', 'No line found');
        return;
      }
      
      let line = '';
      let charCode;
      
      // Read characters until we hit a newline or EOF
      while (true) {
        if (source.read && typeof source.read === 'function') {
          // For TestInputStream objects created in test-helpers
          charCode = source.read();
        } else {
          // Try to find the read method via JRE method lookup
          const readMethod = jvm._jreFindMethod(source.type || 'java/io/InputStream', 'read', '()I');
          if (readMethod) {
            charCode = readMethod(jvm, source, []);
          } else {
            charCode = -1;
          }
        }
        
        if (charCode === -1) {
          // End of stream
          if (line === '') {
            jvm.throwException('java/util/NoSuchElementException', 'No line found');
            return;
          }
          break;
        }
        
        const char = String.fromCharCode(charCode);
        if (char === '\n') {
          break;
        }
        if (char !== '\r') {
          line += char;
        }
      }
      
      return jvm.internString(line);
    }, ['java/lang/IllegalStateException', 'java/util/NoSuchElementException']),
    
    'nextInt()I': withThrows((jvm, obj, args) => {
      if (obj['java/util/Scanner/closed']) {
        jvm.throwException('java/lang/IllegalStateException', 'Scanner closed');
        return;
      }
      
      // Read the next token (skip whitespace) - call the helper function directly
      const token = nextToken(jvm, obj);
      if (!token) {
        jvm.throwException('java/util/NoSuchElementException', 'No int found');
        return;
      }
      
      const intValue = parseInt(token, 10);
      if (isNaN(intValue)) {
        jvm.throwException('java/util/InputMismatchException', 'Not a valid integer: ' + token);
        return;
      }
      
      return intValue;
    }, [
      'java/lang/IllegalStateException',
      'java/util/NoSuchElementException',
      'java/util/InputMismatchException',
    ]),
    
    'next()Ljava/lang/String;': withThrows((jvm, obj, args) => {
      if (obj['java/util/Scanner/closed']) {
        jvm.throwException('java/lang/IllegalStateException', 'Scanner closed');
        return;
      }
      
      const token = nextToken(jvm, obj);
      if (!token) {
        jvm.throwException('java/util/NoSuchElementException', 'No token found');
        return;
      }
      
      return jvm.internString(token);
    }, ['java/lang/IllegalStateException', 'java/util/NoSuchElementException']),
    
    'hasNext()Z': (jvm, obj, args) => {
      if (obj['java/util/Scanner/closed']) {
        return 0;
      }
      
      return obj['java/util/Scanner/hasNext'] ? 1 : 0;
    },
    
    'hasNextLine()Z': (jvm, obj, args) => {
      if (obj['java/util/Scanner/closed']) {
        return 0;
      }
      
      return obj['java/util/Scanner/hasNext'] ? 1 : 0;
    },
    
    'hasNextInt()Z': (jvm, obj, args) => {
      if (obj['java/util/Scanner/closed']) {
        return 0;
      }
      
      // For simplicity, we'll assume if there's input, it might be an int
      return obj['java/util/Scanner/hasNext'] ? 1 : 0;
    },
    
    'close()V': (jvm, obj, args) => {
      obj['java/util/Scanner/closed'] = true;
      const source = obj['java/util/Scanner/source'];
      if (source) {
        // Try to close the underlying stream
        const closeMethod = jvm._jreFindMethod(source.type || 'java/io/InputStream', 'close', '()V');
        if (closeMethod) {
          closeMethod(jvm, source, []);
        }
      }
    }
  }
};
