'use strict';

const test = require('tape');
const path = require('path');

const File = require('../src/jre/java/io/File');
const HashMap = require('../src/jre/java/util/HashMap');
const Pattern = require('../src/jre/java/util/regex/Pattern');
const Matcher = require('../src/jre/java/util/regex/Matcher');

function jvmStub() {
  return {
    nextHashCode: 1,
    internString(value) {
      const str = new String(String(value));
      str.type = 'java/lang/String';
      return str;
    },
  };
}

test('File constructors coerce Java String objects without value fields', (t) => {
  const jvm = jvmStub();
  const parent = jvm.internString('tmp');
  const child = jvm.internString('child.txt');
  const obj = {};

  File.methods['<init>(Ljava/lang/String;Ljava/lang/String;)V'](jvm, obj, [parent, child]);

  t.equal(obj.path, path.join('tmp', 'child.txt'));
  t.end();
});

test('HashMap.computeIfAbsent does not record null mapping results', (t) => {
  const map = {};
  const fn = {
    methods: {
      'apply(Ljava/lang/Object;)Ljava/lang/Object;': () => null,
    },
  };

  HashMap.methods['<init>()V'](null, map, []);
  const value = HashMap.methods['computeIfAbsent(Ljava/lang/Object;Ljava/util/function/Function;)Ljava/lang/Object;'](null, map, ['k', fn]);

  t.equal(value, null);
  t.equal(HashMap.methods['containsKey(Ljava/lang/Object;)Z'](null, map, ['k']), 0);
  t.equal(HashMap.methods['size()I'](null, map, []), 0);
  t.end();
});

test('regex Pattern flags apply to matcher, split, and replace operations', (t) => {
  const jvm = jvmStub();
  const literalDot = Pattern.staticMethods['compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;'](jvm, null, [
    jvm.internString('.'),
    Pattern.staticFields['LITERAL:I'],
  ]);
  const matcher = Pattern.methods['matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;'](jvm, literalDot, [
    jvm.internString('a.b'),
  ]);

  t.equal(Matcher.methods['find()Z'](jvm, matcher, []), 1, 'literal dot finds the actual dot');
  t.equal(Matcher.methods['group()Ljava/lang/String;'](jvm, matcher, []).toString(), '.', 'literal dot group is the dot');
  const split = Pattern.methods['split(Ljava/lang/CharSequence;)[Ljava/lang/String;'](jvm, literalDot, [jvm.internString('a.b')]);
  t.deepEqual(split.map(String), ['a', 'b'], 'split uses quoted literal pattern');

  const replaced = Matcher.methods['replaceAll(Ljava/lang/String;)Ljava/lang/String;'](jvm, matcher, [jvm.internString('X')]);
  t.equal(replaced.toString(), 'aXb', 'replaceAll uses quoted literal pattern');

  const dotAll = Pattern.staticMethods['compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;'](jvm, null, [
    jvm.internString('a.b'),
    Pattern.staticFields['DOTALL:I'],
  ]);
  const dotAllMatcher = Pattern.methods['matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;'](jvm, dotAll, [
    jvm.internString('a\nb'),
  ]);
  t.equal(Matcher.methods['matches()Z'](jvm, dotAllMatcher, []), 1, 'DOTALL lets dot match newline');

  t.end();
});

test('regex Matcher reports capture-group start and end offsets', (t) => {
  const jvm = jvmStub();
  const pattern = Pattern.staticMethods['compile(Ljava/lang/String;)Ljava/util/regex/Pattern;'](jvm, null, [
    jvm.internString('a(b+)c'),
  ]);
  const matcher = Pattern.methods['matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;'](jvm, pattern, [
    jvm.internString('xxabbc'),
  ]);

  t.equal(Matcher.methods['find()Z'](jvm, matcher, []), 1);
  t.equal(Matcher.methods['start(I)I'](jvm, matcher, [1]), 3);
  t.equal(Matcher.methods['end(I)I'](jvm, matcher, [1]), 5);
  t.end();
});
