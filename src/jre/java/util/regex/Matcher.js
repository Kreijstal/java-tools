function stringValue(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string') return obj;
  if (obj && Object.prototype.hasOwnProperty.call(obj, 'value')) return String(obj.value);
  return String(obj);
}

const Pattern = require('./Pattern');

function flagsNoGlobal(matcher) {
  return Pattern.helpers.regexFlags(matcher.pattern).replace(/g/g, '');
}

function flagsNoGlobalWithIndices(matcher) {
  return Pattern.helpers.regexFlags(matcher.pattern, 'd').replace(/g/g, '');
}

function makeRegex(matcher, extraFlags = '') {
  if (matcher.pattern) return Pattern.helpers.makeRegex(matcher.pattern, extraFlags);
  return new RegExp('', extraFlags);
}

function matchIndex(match, group) {
  if (!match.indices || !match.indices[group]) return null;
  return match.indices[group];
}

function ensureMatch(matcher) {
  if (!matcher.lastMatch) {
    throw { type: 'java/lang/IllegalStateException', message: 'No match available' };
  }
  return matcher.lastMatch;
}

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/util/regex/MatchResult'],
  methods: {
    'toMatchResult()Ljava/util/regex/MatchResult;': (jvm, obj) => obj,
    'matches()Z': (jvm, obj) => {
      const pattern = obj.pattern ? Pattern.helpers.regexSource(obj.pattern) : '';
      const match = new RegExp(`^(?:${pattern})$`, flagsNoGlobalWithIndices(obj)).exec(obj.input || '');
      obj.lastMatch = match;
      return match ? 1 : 0;
    },
    'find()Z': (jvm, obj) => {
      if (!obj.regex) {
        obj.regex = makeRegex(obj, 'gd');
      }
      const match = obj.regex.exec(obj.input || '');
      obj.lastMatch = match;
      return match ? 1 : 0;
    },
    'group()Ljava/lang/String;': (jvm, obj) => {
      const match = ensureMatch(obj);
      return jvm.internString(match[0]);
    },
    'group(I)Ljava/lang/String;': (jvm, obj, args) => {
      const match = ensureMatch(obj);
      const group = match[args[0] | 0];
      return group === undefined ? null : jvm.internString(group);
    },
    'groupCount()I': (jvm, obj) => {
      const match = ensureMatch(obj);
      return Math.max(0, match.length - 1);
    },
    'start()I': (jvm, obj) => ensureMatch(obj).index,
    'start(I)I': (jvm, obj, args) => {
      const match = ensureMatch(obj);
      const index = matchIndex(match, args[0] | 0);
      return index ? index[0] : -1;
    },
    'end()I': (jvm, obj) => {
      const match = ensureMatch(obj);
      return match.index + match[0].length;
    },
    'end(I)I': (jvm, obj, args) => {
      const match = ensureMatch(obj);
      const index = matchIndex(match, args[0] | 0);
      return index ? index[1] : -1;
    },
    'replaceAll(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      const replacement = stringValue(args[0]);
      return jvm.internString((obj.input || '').replace(makeRegex(obj, 'g'), replacement));
    },
    'reset()Ljava/util/regex/Matcher;': (jvm, obj) => {
      if (obj.regex) obj.regex.lastIndex = 0;
      obj.lastMatch = null;
      return obj;
    },
    'reset(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;': (jvm, obj, args) => {
      obj.input = stringValue(args[0]);
      if (obj.regex) obj.regex.lastIndex = 0;
      obj.lastMatch = null;
      return obj;
    },
  },
};
