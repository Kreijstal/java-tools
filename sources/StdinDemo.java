import java.util.Scanner;

public class StdinDemo {
    public static void main(String[] args) {
        System.out.println("Hello! What's your name?");
        Scanner scanner = new Scanner(System.in);
        String name = scanner.nextLine();
        System.out.println("Nice to meet you, " + name + "!");
        
        System.out.println("What's your favorite number?");
        int number = scanner.nextInt();
        System.out.println("Great choice! " + number + " is a wonderful number.");
        
        scanner.close();
    }
}