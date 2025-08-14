public class Main {
    public static void main(String[] args) {
        Animal myAnimal = new Animal();
        Animal myDog = new Dog();
        Dog myRealDog = new Dog();

        myAnimal.makeSound(); // The animal makes a sound
        myDog.makeSound();    // The dog barks

        System.out.println(myDog instanceof Animal); // true
        System.out.println(myDog instanceof Dog);    // true
        System.out.println(myAnimal instanceof Dog); // false

        myRealDog.printName(); // Animal
        System.out.println(myRealDog.breed); // Golden Retriever
    }
}
