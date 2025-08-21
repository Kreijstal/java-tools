public class InterfaceRunner {
    public static void main(String[] args) {
        RenameableInterface obj = new MyImplementation();
        System.out.println(obj.methodToRename());
    }
}
