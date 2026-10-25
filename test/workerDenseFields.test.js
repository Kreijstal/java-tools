const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('worker-dense-fields-');

test('a doubly linked list keeps its forward and backward links with dense instance fields', async t => {
  const classpath = compileFixture(t, 'DenseList', `
class Link { Link next, previous; }
public class DenseList {
  Link head;
  DenseList() { head = new Link(); head.next = head; head.previous = head; }
  void append(Link node) {
    node.previous = head.previous; node.next = head;
    node.previous.next = node; node.next.previous = node;
  }
  public static void main(String[] args) {
    DenseList list = new DenseList(); Link first = new Link(); Link second = new Link();
    list.append(first); list.append(second);
    System.out.println(list.head.next == first && first.next == second &&
      second.previous == first && list.head.previous == second);
  }
}`);
  const jvm = new JVM({classpath, denseInstanceFields: true});
  let output = '';
  jvm.registerJreMethods({'java/io/PrintStream': {
    'println(Z)V': (_jvm, _receiver, args) => {output += String(args[0]);},
  }});
  await jvm.run('DenseList');
  t.ok(output === '1' || output === 'true', `all forward and backward links use the same field storage (${output})`);
  t.end();
});
