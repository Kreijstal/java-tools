// Reachability preparation fixture: PrepUsed is a direct reference,
// PrepNamed is reached only through a literal Class.forName, PrepLate only
// through a name built at run time, and PrepUnrelated not at all.
public class PrepMain {
  public static void main(String[] args) throws Exception {
    System.out.println(PrepUsed.value());
    System.out.println(Class.forName("PrepNamed").getName());
    String late = new StringBuilder("etaLperP").reverse().toString();
    System.out.println(Class.forName(late).getName());
  }
}
class PrepUsed { static int value() { return 7; } }
class PrepNamed {}
class PrepLate {}
class PrepUnrelated {}
