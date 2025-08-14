public class Dog extends Animal {
    String breed = "Golden Retriever";

    @Override
    public void makeSound() {
        System.out.println("The dog barks");
    }

    public void wagTail() {
        System.out.println("The dog wags its tail");
    }

    public void printName() {
        System.out.println(super.name);
    }
}
