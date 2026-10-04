'use strict';
const test = require('tape');
const { parse } = require('../../src/javac-js/parser');
const { sx } = require('../../src/javac-js/sexpr');

function expr(src) {
  try {
    const cu = parse(`class T { Object f = ${src}; }`, 'T.java');
    return sx(cu.types[0].defs[0].init);
  } catch (e) {
    return 'ERROR ' + e.message;
  }
}

const cases = [
  ['a + b * c', '(+ a (* b c))'],
  ['a - b - c', '(- (- a b) c)'],
  ['a = b = c', '(= a (= b c))'],
  ['a ? b : c ? d : e', '(? a b (? c d e))'],
  ['(int) x + 1', '(+ (cast int x) 1)'],
  ['(Foo) x', '(cast Foo x)'],
  ['(a) + b', '(+ (a) b)'],
  ['(a) - 1', '(- (a) 1)'],
  ['(List<String>) o', '(cast List<String> o)'],
  ['(Runnable & Serializable) () -> {}', '(cast Runnable&Serializable (lambda () {...}))'],
  ['x -> x + 1', '(lambda (x) (+ x 1))'],
  ['(x, y) -> x', '(lambda (x y) x)'],
  ['(int x, String y) -> x', '(lambda (int x String y) x)'],
  ['a < b', '(< a b)'],
  ['a < b && c > d', '(&& (< a b) (> c d))'],
  ['i < n >> 1', '(< i (>> n 1))'],
  ['List<String>::size', '(ref List<String> size)'],
  ['String[]::new', '(ref String[] <init>)'],
  ['int[].class', 'int[].class'],
  ['Map.Entry<K, V>::getKey', '(ref Map.Entry<K,V> getKey)'],
  ['Collections.<String>emptyList()', '(call Collections.emptyList<String> )'],
  ['o instanceof String s && s.isEmpty()', '(&& (instanceof o [String s]) (call s.isEmpty ))'],
  ['o instanceof Point(int x, var y)', '(instanceof o [Point([int x] [_ y])])'],
  ['-2147483648', '-2147483648'],
  ['-9223372036854775808L', '-9223372036854775808L'],
  ['0xFFFFFFFF', '-1'],
  ['0x8000_0000', '-2147483648'],
  ['(short)((d & 0x8000_0000) >> 16)', '(cast short ((>> ((& d -2147483648)) 16)))'],
  ['new int[3][]', '(newarray int[] [3] )'],
  ['new String[] {"a", "b"}', '(newarray String [] {"a" "b"})'],
  ['outer.new Inner(1)', '(new outer.Inner 1)'],
  ['new ArrayList<>()', '(new ArrayList<> )'],
  ['a.b.c(d)[e].f', '(call a.b.c d)[e].f'],
  ['x++ + ++y', '(+ (postinc x) (preinc y))'],
  ['!a == b', '(== (not a) b)'],
  ['(a < b) ? c : d', '(? ((< a b)) c d)'],
  ['f((x) -> x)', '(call f (lambda (x) x))'],
  ['b ? x -> 1 : x -> 2', '(? b (lambda (x) 1) (lambda (x) 2))'],
  ['"a" + 1 + 2', '(+ (+ "a" 1) 2)'],
  ['super.toString()', '(call super.toString )'],
  ['Outer.this.x', 'Outer.this.x'],
  ['Outer.super.m()', '(call Outer.super.m )'],
  ['this::m', '(ref this m)'],
  ['super::m', '(ref super m)'],
  ['(String) (Object) s', '(cast String (cast Object s))'],
  ['(a + b)', '((+ a b))'],
  ['(T[]) new Object[n]', '(cast T[] (newarray Object [n] ))'],
  ['(char) -1', '(cast char -1)'],
];

test('javac-js parser expression shapes', (t) => {
  for (const [src, want] of cases) t.equal(expr(src), want, src);
  t.end();
});

test('javac-js parser statements', (t) => {
  const cu = parse(`class T { void m() {
    int a = 1, b[] = {2};
    List<String> l = null;
    Map.Entry<K, V>[] es;
    var v = 3;
    for (int i = 0, j = 1; i < j; i++, j--) {}
    for (var e : list) {}
    label: while (true) break label;
    switch (x) { case 1, 2 -> f(); case Foo f when f.ok() -> {} default -> {} }
    int y = switch (x) { case 1: yield 2; default: yield 3; };
    try (var r = open(); other) {} catch (A | B e) {} finally {}
    record R(int a) {}
    yield(1);
  } }`, 'T.java');
  const stats = cu.types[0].defs[0].body.stats;
  t.deepEqual(stats.map((s) => s.tag), ['VarDecl', 'VarDecl', 'VarDecl', 'VarDecl', 'VarDecl', 'ForLoop', 'ForeachLoop', 'Labelled', 'Switch', 'VarDecl', 'Try', 'ClassDef', 'Yield']);
  t.end();
});
