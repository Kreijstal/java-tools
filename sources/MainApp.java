public class MainApp {
    public static void main(String[] args) {
        ThingProducer producer = new ThingProducer();
        Thing myThing = producer.produceThing("MyThing");
        System.out.println("Produced a thing with name: " + myThing.getName());
    }
}
