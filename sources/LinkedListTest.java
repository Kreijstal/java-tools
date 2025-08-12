import java.util.LinkedList;

public class LinkedListTest {
    public static void main(String[] args) {
        LinkedList<String> list = new LinkedList<String>();
        list.add("Hello");
        list.add("World");
        System.out.println(list.get(0));
        System.out.println(list.get(1));
    }
}
