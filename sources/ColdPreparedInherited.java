public final class ColdPreparedInherited {
    public static int storeInherited(boolean choose, int value) {
        return ColdInheritedChild.number = choose ? value : value + 1;
    }
}
class ColdInheritedParent {
    static int number = 0;
}
class ColdInheritedChild extends ColdInheritedParent {}
