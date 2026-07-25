function stringValue(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string') return obj;
  if (obj && Object.prototype.hasOwnProperty.call(obj, 'value')) return String(obj.value);
  return String(obj);
}

const FLAG_CASE_INSENSITIVE = 2;
const FLAG_MULTILINE = 8;
const FLAG_LITERAL = 16;
const FLAG_DOTALL = 32;

function quoteRegex(source) {
  return String(source).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function jsFlags(javaFlags) {
  let flags = '';
  if ((javaFlags & FLAG_CASE_INSENSITIVE) !== 0) flags += 'i';
  if ((javaFlags & FLAG_MULTILINE) !== 0) flags += 'm';
  if ((javaFlags & FLAG_DOTALL) !== 0) flags += 's';
  return flags;
}

function regexSource(patternObj) {
  const source = stringValue(patternObj && patternObj.pattern);
  return ((patternObj && patternObj.flags) & FLAG_LITERAL) !== 0 ? quoteRegex(source) : source;
}

function regexFlags(patternObj, extraFlags = '') {
  const flags = new Set(`${(patternObj && patternObj.jsFlags) || ''}${extraFlags}`.split('').filter(Boolean));
  return Array.from(flags).join('');
}

function makeRegex(patternObj, extraFlags = '') {
  return new RegExp(regexSource(patternObj), regexFlags(patternObj, extraFlags));
}

function makePattern(jvm, pattern, flags = 0) {
  return {
    type: 'java/util/regex/Pattern',
    pattern: stringValue(pattern),
    flags: flags | 0,
    jsFlags: jsFlags(flags | 0),
  };
}

module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'UNIX_LINES:I': 1,
    'CASE_INSENSITIVE:I': 2,
    'COMMENTS:I': 4,
    'MULTILINE:I': 8,
    'LITERAL:I': 16,
    'DOTALL:I': 32,
    'UNICODE_CASE:I': 64,
    'CANON_EQ:I': 128,
    'UNICODE_CHARACTER_CLASS:I': 256,
  },
  staticMethods: {
    'compile(Ljava/lang/String;)Ljava/util/regex/Pattern;': (jvm, obj, args) => makePattern(jvm, args[0], 0),
    'compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;': (jvm, obj, args) => makePattern(jvm, args[0], args[1]),
    'matches(Ljava/lang/String;Ljava/lang/CharSequence;)Z': (jvm, obj, args) => {
      const pattern = stringValue(args[0]);
      const input = stringValue(args[1]);
      return new RegExp(`^(?:${pattern})$`).test(input) ? 1 : 0;
    },
    'quote(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(quoteRegex(stringValue(args[0])));
    },
  },
  methods: {
    'matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;': (jvm, obj, args) => {
      return {
        type: 'java/util/regex/Matcher',
        pattern: obj,
        input: stringValue(args[0]),
        regex: makeRegex(obj, 'gd'),
        lastMatch: null,
      };
    },
    'pattern()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.pattern || ''),
    'flags()I': (jvm, obj) => obj.flags || 0,
    'split(Ljava/lang/CharSequence;)[Ljava/lang/String;': (jvm, obj, args) => {
      const pieces = stringValue(args[0]).split(makeRegex(obj));
      const result = pieces.map((piece) => jvm.internString(piece));
      result.type = '[Ljava/lang/String;';
      result.elementType = 'java/lang/String';
      return result;
    },
    'split(Ljava/lang/CharSequence;I)[Ljava/lang/String;': (jvm, obj, args) => {
      const limit = args[1] | 0;
      let pieces = stringValue(args[0]).split(makeRegex(obj));
      if (limit > 0 && pieces.length > limit) {
        pieces = pieces.slice(0, limit - 1).concat(pieces.slice(limit - 1).join(''));
      }
      const result = pieces.map((piece) => jvm.internString(piece));
      result.type = '[Ljava/lang/String;';
      result.elementType = 'java/lang/String';
      return result;
    },
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.pattern || ''),
  },
  helpers: {
    makeRegex,
    regexFlags,
    regexSource,
  },
};
