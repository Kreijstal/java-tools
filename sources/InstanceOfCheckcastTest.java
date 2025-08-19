class Animal {}
class Dog extends Animal implements Runnable {
    public void run() {
        System.out.println("Dog is running");
    }
    public void bark() {
        System.out.println("Woof!");
    }
}
class Cat extends Animal {}

public class InstanceOfCheckcastTest {
    public static void main(String[] args) {
        Animal myAnimal = new Dog();

        // Test instanceof
        System.out.println(myAnimal instanceof Animal); // true
        System.out.println(myAnimal instanceof Dog);    // true
        System.out.println(myAnimal instanceof Cat);    // false
        System.out.println(myAnimal instanceof Runnable); // true

        // Test checkcast
        if (myAnimal instanceof Dog) {
            Dog myDog = (Dog) myAnimal; // checkcast
            myDog.bark();
        }

        try {
            Cat myCat = (Cat) myAnimal; // should throw ClassCastException
            myCat.toString(); // to prevent unused variable warning
        } catch (ClassCastException e) {
            System.out.println("Caught expected ClassCastException");
        }
    }
}
