public class ClosedCurrentThread {

    public static int bench(int repetitions) {
        Thread self = Thread.currentThread();
        int failures = 0;
        for (int i = 0; i < repetitions; i++) if (Thread.currentThread() != self) failures++;
        return failures;
    }
    static class Reader extends Thread {
        int before, after;
        public void run() {
            Thread self = Thread.currentThread();
            before = self == this && bench(1000) == 0 ? 1 : 1000;
            try {Thread.sleep(2);} catch (InterruptedException e) {throw new RuntimeException(e);}
            after = Thread.currentThread() == self ? 1 : 1000;
        }
    }
    public static void main(String[] args) throws Exception {
        Thread main = Thread.currentThread();
        Reader first = new Reader(), second = new Reader();
        first.start(); second.start(); first.join(); second.join();
        System.out.println(first.before + first.after + second.before + second.after);
        System.out.println(main == Thread.currentThread());
        System.out.println(bench(1000));
    }
}
