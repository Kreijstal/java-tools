public class WarmMain {
    public static void main(String[] args) {
        for (int i = 0; i < 300000; i++) {
            Work.tick(i);
        }
        Halt.stop();
        for (int i = 0; i < 50; i++) {
            Work.tick(i);
        }
        System.out.println(Work.total);
    }
}
